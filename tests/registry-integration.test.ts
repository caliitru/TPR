import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import {
  sourceCatalog,
  seedSourceCatalog,
} from '../packages/db/source-catalog.js';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
  sourceHealth,
  suspendSource,
} from '../packages/core/sources.js';
import {
  mockPolicy,
  mockDefinitions,
  mockTransportFor,
} from '../packages/connectors/mock-scenarios.js';
import { collectSource } from '../packages/core/collection.js';
import { app } from '../apps/api/app.js';
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error('Disposable test database required');
const db = database();
const actor = { id: 'registry-test-admin', role: 'admin' as const };
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.pool.end();
});
beforeEach(async () => {
  await db.pool.query(
    'TRUNCATE job_events,tombstones,export_batches,review_events,observations,source_items,crawl_jobs,product_aliases,catalog_products,sources,source_policies CASCADE',
  );
  await seed(db);
  await seedSourceCatalog(db, actor);
});
const definition = (category: string) =>
  sourceCatalog.find((s) => s.registry!.category === category)!;
const review = (category: string) => ({
  source_verified: true,
  commercial_use_verified: true,
  access_verified: true,
  method: category === 'editorial' ? 'official-feed' : 'official-api',
  evidence_links: ['https://permissions.example.org/synthetic-contract'],
  approved_content: definition(category).registry!.content_types,
});
async function prepare(category: string) {
  const def = definition(category);
  await registerSource(
    db,
    { ...def, registry: { ...def.registry, commercial_use: 'approved' } },
    actor,
    true,
  );
  return def;
}
it('seeds exactly 43 disabled, pending candidates with unique identities and no granted operations', async () => {
  const rows = (await sourceHealth(db)).filter((s) => s.registry);
  expect(rows).toHaveLength(43);
  expect(new Set(rows.map((s) => s.source_id)).size).toBe(43);
  for (const s of rows) {
    expect(s.enabled).toBe(false);
    expect(s.status).toBe('pending');
    expect(s.registry.commercial_use).toBe('permission-required');
    expect(s.allowed_operations).toEqual({});
    expect(s.live_authorized).toBe(false);
  }
  expect(rows.filter((s) => s.registry.category === 'reddit')).toHaveLength(9);
  expect(
    rows.filter((s) => s.registry.category === 'manufacturer'),
  ).toHaveLength(16);
});
it('concurrent idempotent seeding preserves operator edits, suspension, permissions and history', async () => {
  const def = definition('community');
  await db.pool.query(
    "UPDATE sources SET registry=jsonb_set(registry,'{notes}','\"operator note\"'),operational_state='suspended' WHERE source_id=$1",
    [def.source_id],
  );
  const before = (await db.pool.query('SELECT count(*) FROM source_events'))
    .rows;
  const results = await Promise.all([
    seedSourceCatalog(db, actor),
    seedSourceCatalog(db, actor),
  ]);
  expect(results.every((r) => r.inserted === 0)).toBe(true);
  const row = (await sourceHealth(db)).find(
    (s) => s.source_id === def.source_id,
  )!;
  expect(row.registry.notes).toBe('operator note');
  expect(row.operational_state).toBe('suspended');
  expect(
    (await db.pool.query('SELECT count(*) FROM source_events')).rows,
  ).toEqual(before);
});
it('rejects alternate IDs for the same category and URL, allowing distinct editorial/community scopes', async () => {
  const def = definition('community');
  await expect(
    registerSource(db, { ...def, source_id: 'duplicate-community' }, actor),
  ).rejects.toThrow('source_registry_identity');
  expect(
    (await sourceHealth(db)).filter(
      (s) => s.registry?.domain === 'thehackersparadise.com',
    ),
  ).toHaveLength(2);
});
it('disabled candidates never make requests and missing commercial review blocks approval and activation', async () => {
  for (const def of sourceCatalog) {
    const transport = mockTransportFor(def.type);
    const result = await collectSource(db, def.source_id, randomUUID(), {
      actor,
      transport,
      force: true,
    });
    expect(result.requests).toBe(0);
    await expect(enableMockSource(db, def.source_id, actor)).rejects.toThrow();
  }
  await expect(
    approveSourcePolicy(
      db,
      definition('reddit').source_id,
      mockPolicy(),
      actor,
    ),
  ).rejects.toThrow('commercial_permission_required');
  const def = await prepare('community');
  await expect(
    approveSourcePolicy(db, def.source_id, mockPolicy(), actor),
  ).rejects.toThrow('commercial_permission_required');
});
it('records reviewed scope and evidence, requires separate activation and expires closed', async () => {
  const def = await prepare('community');
  await approveSourcePolicy(
    db,
    def.source_id,
    { ...mockPolicy(), registry_review: review('community') },
    actor,
  );
  const approved = (await sourceHealth(db)).find(
    (s) => s.source_id === def.source_id,
  )!;
  expect(approved.enabled).toBe(false);
  expect(approved.registry_review.evidence_links).toHaveLength(1);
  expect(approved.reviewed_by).toBe(actor.id);
  await enableMockSource(db, def.source_id, actor);
  await db.pool.query(
    "UPDATE source_policies SET expires_at=now()-interval '1 second' WHERE policy_id=(SELECT policy_id FROM sources WHERE source_id=$1)",
    [def.source_id],
  );
  const result = await collectSource(db, def.source_id, randomUUID(), {
    actor,
    transport: mockTransportFor('forum'),
    force: true,
  });
  expect(result.requests).toBe(0);
});
it('rejects unauthorized methods, content scopes and scoring use for retailers/manufacturers', async () => {
  for (const category of ['retailer', 'manufacturer']) {
    const def = await prepare(category);
    await expect(
      approveSourcePolicy(
        db,
        def.source_id,
        { ...mockPolicy(), registry_review: review(category) },
        actor,
      ),
    ).rejects.toThrow(
      category === 'retailer'
        ? 'retailer_evidence_prohibited'
        : 'manufacturer_player_evidence_prohibited',
    );
  }
  const def = await prepare('community');
  await expect(
    approveSourcePolicy(
      db,
      def.source_id,
      {
        ...mockPolicy(),
        registry_review: { ...review('community'), method: 'authorized-page' },
      },
      actor,
    ),
  ).rejects.toThrow('collection_method_not_implemented');
  await expect(
    approveSourcePolicy(
      db,
      def.source_id,
      {
        ...mockPolicy(),
        registry_review: {
          ...review('community'),
          approved_content: ['customer-reviews'],
        },
      },
      actor,
    ),
  ).rejects.toThrow('unapproved_collection_scope');
});
it('suspension prevents reactivation and leaves no queued or running collection jobs', async () => {
  const def = mockDefinitions.find((s) => s.type === 'forum')!;
  await registerSource(db, def, actor);
  await approveSourcePolicy(db, def.source_id, mockPolicy(), actor);
  await enableMockSource(db, def.source_id, actor);
  await suspendSource(db, def.source_id, actor);
  await expect(enableMockSource(db, def.source_id, actor)).rejects.toThrow(
    'source_suspended',
  );
  await expect(
    collectSource(db, def.source_id, randomUUID(), {
      actor,
      transport: mockTransportFor('forum'),
      force: true,
    }),
  ).rejects.toThrow('source_suspended');
  expect(
    (
      await db.pool.query(
        "SELECT 1 FROM crawl_jobs WHERE source_id=$1 AND state IN ('queued','running','retry')",
        [def.source_id],
      )
    ).rowCount,
  ).toBe(0);
});
it('filters the centralized registry by search, priority, permission, type and operation', async () => {
  expect(
    await sourceHealth(db, {
      q: 'Garmin',
      priority: 'P1',
      approval: 'pending',
      operational: 'disabled',
    }),
  ).toHaveLength(3);
  expect(await sourceHealth(db, { type: 'manufacturer' })).toHaveLength(16);
  await expect(sourceHealth(db, { priority: 'P0' })).rejects.toThrow();
});
it('requires administrator authority for seeding and uses existing authenticated source APIs', async () => {
  await expect(
    seedSourceCatalog(db, { id: 'reader', role: 'reviewer' }),
  ).rejects.toThrow();
  const server = await app(db, {
    admin: 'registry-admin-token-12345678901234567890',
    reviewer: 'registry-reviewer-token-12345678901234567890',
  });
  try {
    expect((await server.inject({ url: '/sources' })).statusCode).toBe(401);
    const response = await server.inject({
      url: '/sources?priority=P3',
      headers: {
        authorization: 'Bearer registry-admin-token-12345678901234567890',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(6);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/sources/catalog-manufacturer-ping',
          headers: {
            authorization: 'Bearer registry-admin-token-12345678901234567890',
            'x-tpr-review': '1',
          },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await server.close();
  }
});

it('approved retailer collection stores source metadata without observations, ratings or facts', async () => {
  const def = await prepare('retailer');
  const policy = mockPolicy();
  await approveSourcePolicy(
    db,
    def.source_id,
    {
      ...policy,
      operations: {
        ...policy.operations,
        derived_insights: false,
        analyze_body: false,
        manufacturer_facts: false,
      },
      registry_review: review('retailer'),
    },
    actor,
  );
  await enableMockSource(db, def.source_id, actor);
  const { MockTransport } = await import('../packages/connectors/http.js');
  const transport = new MockTransport(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      items: [
        {
          external_id: 'retail-synthetic',
          url: def.url,
          published_at: null,
          title: 'Ping G440 Max Driver',
          kind: 'player',
          body: 'I own this. Good forgiveness.',
          structured: {
            explicit_rating: {
              value: 5,
              scale_min: 1,
              scale_max: 5,
              evidence_basis: 'structured_source_field',
            },
          },
        },
      ],
    }),
  }));
  const result = await collectSource(db, def.source_id, randomUUID(), {
    actor,
    transport,
    force: true,
  });
  expect(result.state).toBe('completed');
  expect(result.requests).toBe(1);
  expect(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM source_items WHERE source_id=$1',
        [def.source_id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM observations')).rows[0]
      .n,
  ).toBe(0);
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM manufacturer_facts'))
      .rows[0].n,
  ).toBe(0);
});

it('prioritizes approved active sources only and blocks unapproved content scopes before staging', async () => {
  const { collectDue } = await import('../packages/core/collection.js');
  const { MockTransport } = await import('../packages/connectors/http.js');
  const community = await prepare('community');
  await approveSourcePolicy(
    db,
    community.source_id,
    {
      ...mockPolicy(),
      registry_review: {
        ...review('community'),
        approved_content: ['product-discovery'],
      },
    },
    actor,
  );
  await enableMockSource(db, community.source_id, actor);
  const retailer = await prepare('retailer');
  const policy = mockPolicy();
  await approveSourcePolicy(
    db,
    retailer.source_id,
    {
      ...policy,
      operations: {
        ...policy.operations,
        derived_insights: false,
        analyze_body: false,
        manufacturer_facts: false,
      },
      registry_review: review('retailer'),
    },
    actor,
  );
  await enableMockSource(db, retailer.source_id, actor);
  const ids: string[] = [];
  const results = await collectDue(db, {
    actor,
    transport: new MockTransport(() => {
      throw new Error('unused');
    }),
    transportForSource: async (id) => {
      ids.push(id);
      const def = id === community.source_id ? community : retailer;
      return new MockTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              external_id: 'scope-test',
              url: def.url,
              published_at: null,
              title: 'Ping G440 Max Driver',
              kind: 'player',
              body: 'I own this club. Good forgiveness.',
            },
          ],
        }),
      }));
    },
  });
  expect(ids).toEqual([community.source_id, retailer.source_id]);
  expect(results[0]!.state).toBe('dead_letter');
  expect((results[0] as { error_code?: string }).error_code).toBe(
    'unapproved_content_type',
  );
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM observations')).rows[0]
      .n,
  ).toBe(0);
});
