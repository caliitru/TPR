import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, it, describe, expect } from 'vitest';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
  suspendSource,
} from '../packages/core/sources.js';
import { collectSource, collectDue } from '../packages/core/collection.js';
import {
  mockDefinitions,
  mockPolicy,
  mockTransportFor,
} from '../packages/connectors/mock-scenarios.js';
import {
  MockTransport,
  CollectionError,
  PinnedHttpsTransport,
  type HttpResponse,
} from '../packages/connectors/http.js';
import {
  correctProductMatch,
  purgeExpiredMetadata,
  reviewFact,
  addCatalogProduct,
} from '../packages/core/operations.js';
import { review } from '../packages/core/moderation.js';
import {
  exportLocal,
  previewExport,
  retractions,
} from '../packages/adapters/export.js';
import { ingest, enqueue, processNext } from '../packages/core/pipeline.js';
import { fixtureConnector } from '../packages/connectors/index.js';
import { app } from '../apps/api/app.js';
import type { Observation } from '../packages/contracts/index.js';
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error('Phase 2 integration requires disposable test database');
const db = database(),
  actor = { id: 'phase2-test-admin', role: 'admin' as const };
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tpr-phase2-'));
  await migrate(db);
});
afterAll(async () => {
  await db.pool.end();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.pool.query(
    'TRUNCATE job_events,tombstones,export_batches,review_events,observations,source_items,crawl_jobs,product_aliases,catalog_products,sources,source_policies CASCADE',
  );
  await seed(db);
});
async function setup(type = 'forum', approved = true, enabled = true) {
  const def = mockDefinitions.find((s) => s.type === type)!;
  await registerSource(db, def, actor);
  if (approved)
    await approveSourcePolicy(db, def.source_id, mockPolicy(), actor);
  if (enabled) await enableMockSource(db, def.source_id, actor);
  return def;
}
async function obs() {
  return (
    await db.pool.query<{ payload: Observation }>(
      `SELECT payload FROM observations WHERE payload->>'source_id' LIKE 'demo-%' ORDER BY observation_id`,
    )
  ).rows.map((r) => r.payload);
}
async function approve(o: Observation) {
  return review(
    db,
    o.observation_id,
    {
      action: 'approve',
      reason: 'verified_fixture',
      idempotency_key: randomUUID(),
    },
    actor,
  );
}
async function collect(
  source = 'demo-forum',
  transport = mockTransportFor('forum'),
  key = randomUUID(),
) {
  return collectSource(db, source, key, { actor, transport, force: true });
}
async function exported() {
  return exportLocal(db, {
    actor,
    authorizeLocalExport: true,
    type: 'analysis_observations',
    directory,
  });
}
describe('registry, permissions and collection controls', () => {
  it('registers disabled sources; unapproved/disabled/expired/scope-mismatched sources make zero requests', async () => {
    await setup('forum', false, false);
    const t = mockTransportFor('forum');
    expect((await collect('demo-forum', t)).state).toBe('dead_letter');
    expect(t.requests).toHaveLength(0);
    await approveSourcePolicy(db, 'demo-forum', mockPolicy(), actor);
    expect((await collect('demo-forum', t)).state).toBe('dead_letter');
    expect(t.requests).toHaveLength(0);
    await enableMockSource(db, 'demo-forum', actor);
    await db.pool.query(
      `UPDATE source_policies SET expires_at=now()-interval '1 second' WHERE policy_id=(SELECT policy_id FROM sources WHERE source_id='demo-forum')`,
    );
    expect((await collect('demo-forum', t)).state).toBe('dead_letter');
    expect(t.requests).toHaveLength(0);
    await approveSourcePolicy(db, 'demo-forum', mockPolicy(), actor);
    await enableMockSource(db, 'demo-forum', actor);
    expect(
      (
        await collectSource(db, 'demo-forum', randomUUID(), {
          actor,
          transport: new PinnedHttpsTransport([]),
          force: true,
        })
      ).state,
    ).toBe('dead_letter');
    expect(t.requests).toHaveLength(0);
  });
  it('requires admin policy activation, immutable source audit and reapproval after edits', async () => {
    await setup();
    await expect(
      enableMockSource(db, 'demo-forum', { id: 'reader', role: 'reviewer' }),
    ).rejects.toThrow('actor');
    await expect(
      registerSource(
        db,
        mockDefinitions.find((s) => s.type === 'forum'),
        actor,
        true,
      ),
    ).rejects.toThrow('disable');
    await suspendSource(db, 'demo-forum', actor);
    await registerSource(
      db,
      {
        ...mockDefinitions.find((s) => s.type === 'forum')!,
        interval_seconds: 7200,
      },
      actor,
      true,
    );
    await expect(enableMockSource(db, 'demo-forum', actor)).rejects.toThrow(
      'policy_denied',
    );
    await expect(
      db.pool.query("UPDATE source_events SET code='tamper'"),
    ).rejects.toThrow('append-only');
    await expect(
      approveSourcePolicy(
        db,
        'demo-forum',
        { ...mockPolicy(), scope: 'live' },
        actor,
      ),
    ).rejects.toThrow();
  });
  it('enforces persistent daily quota and avoids charging duplicate completed run keys', async () => {
    await setup('youtube');
    await db.pool.query(
      "UPDATE sources SET daily_budget=100 WHERE source_id='demo-youtube'",
    );
    const t = mockTransportFor('youtube'),
      key = randomUUID();
    const first = await collect('demo-youtube', t, key);
    expect(first.error_code).toBe('quota_exhausted');
    expect(t.requests).toHaveLength(1);
    expect(await obs()).toHaveLength(1);
    await db.pool.query(
      "UPDATE sources SET quota_day=current_date-1,next_collection_at=now() WHERE source_id='demo-youtube'",
    );
    await db.pool.query(
      "UPDATE crawl_jobs SET next_retry_at=now() WHERE source_id='demo-youtube'",
    );
    const second = await collect('demo-youtube', t, key);
    expect(second.state).toBe('completed');
    expect(t.requests).toHaveLength(2);
    expect(await obs()).toHaveLength(2);
    await collect('demo-youtube', t, key);
    expect(t.requests).toHaveLength(2);
  });
  it('rate-limits before requests, resumes persisted pages and respects source scheduling', async () => {
    await setup();
    await db.pool.query(
      "UPDATE sources SET min_request_interval_ms=60000 WHERE source_id='demo-forum'",
    );
    const t = mockTransportFor('forum'),
      key = randomUUID();
    const result = await collect('demo-forum', t, key);
    expect(result.error_code).toBe('rate_limited');
    expect(await obs()).toHaveLength(1);
    await db.pool.query(
      "UPDATE sources SET last_request_at=now()-interval '2 minutes' WHERE source_id='demo-forum'",
    );
    await db.pool.query(
      "UPDATE crawl_jobs SET next_retry_at=now() WHERE source_id='demo-forum'",
    );
    expect((await collect('demo-forum', t, key)).state).toBe('completed');
    expect(t.requests).toHaveLength(2);
    expect(await obs()).toHaveLength(2);
    const after = await collectSource(db, 'demo-forum', randomUUID(), {
      actor,
      transport: t,
    });
    expect(after.requests).toBe(0);
    expect(t.requests).toHaveLength(2);
  });
  it('retries 429/500/timeouts with backoff and dead-letters bounded failures', async () => {
    await setup();
    const t = new MockTransport(() => {
      throw new CollectionError('500');
    });
    const key = randomUUID();
    for (let i = 0; i < 3; i++) {
      await db.pool.query('UPDATE crawl_jobs SET next_retry_at=now()');
      const r = await collect('demo-forum', t, key);
      expect(r.state).toBe(i === 2 ? 'dead_letter' : 'retry');
    }
    expect(t.requests).toHaveLength(3);
    const timeout = new MockTransport(() => {
      throw new CollectionError('timeout');
    });
    expect((await collect('demo-forum', timeout)).error_code).toBe('timeout');
    const rate = new MockTransport(() => ({
      status: 429,
      headers: { 'retry-after': '120' },
      body: 'no raw body retained',
    }));
    const r = await collect('demo-forum', rate);
    expect(r.error_code).toBe('429');
    expect(
      (
        await db.pool.query(
          "SELECT next_retry_at>now()+interval '110 seconds' AS future FROM crawl_jobs WHERE job_id=$1",
          [r.job_id],
        )
      ).rows[0].future,
    ).toBe(true);
  });
  it('403 shuts down source; manual suspension revokes facts/evidence and suppresses exports', async () => {
    await setup();
    await collect();
    const candidate = (await obs()).find((o) => !o.quality_flags.length)!;
    await approve(candidate);
    const batch = await exported();
    await suspendSource(db, 'demo-forum', actor);
    expect((await exported()).manifest.count).toBe(0);
    expect(await retractions(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batch_id: batch.manifest.batch_id }),
      ]),
    );
    await approveSourcePolicy(db, 'demo-forum', mockPolicy(), actor);
    await enableMockSource(db, 'demo-forum', actor);
    const t = new MockTransport(() => ({
      status: 403,
      headers: {},
      body: 'private error',
    }));
    expect((await collect('demo-forum', t)).state).toBe('dead_letter');
    expect(
      (
        await db.pool.query(
          "SELECT enabled FROM sources WHERE source_id='demo-forum'",
        )
      ).rows[0].enabled,
    ).toBe(false);
  });
  it('denies redirects, unsafe pagination and oversized HTTP responses', async () => {
    await setup();
    for (const response of [
      { status: 302, headers: { location: 'https://127.0.0.1' }, body: '' },
      { status: 200, headers: {}, body: 'x'.repeat(1000001) },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ items: [], next: 'https://127.0.0.1' }),
      },
    ]) {
      const t = new MockTransport((): HttpResponse => response as HttpResponse);
      const r = await collect('demo-forum', t);
      expect(r.state).not.toBe('completed');
      expect(t.requests).toHaveLength(1);
    }
  });
});
describe('end-to-end evidence, product facts and operations', () => {
  it('all four connectors run mocked HTTP; repeats dedupe and RSS uses conditional requests', async () => {
    for (const type of ['youtube', 'rss', 'manufacturer', 'forum']) {
      const def = await setup(type);
      const t = mockTransportFor(def.type);
      expect((await collect(def.source_id, t)).state).toBe('completed');
      const before = (await obs()).length;
      await collect(def.source_id, t);
      expect((await obs()).length).toBe(before);
      if (type === 'rss')
        expect(t.requests[1]!.headers?.['if-none-match']).toBeDefined();
    }
    expect(await obs()).toHaveLength(5);
    expect(
      (await db.pool.query('SELECT * FROM manufacturer_facts')).rowCount,
    ).toBe(1);
    expect(
      (await obs()).every((o) => o.observation_kind !== 'manufacturer_fact'),
    ).toBe(true);
    expect((await obs()).every((o) => o.review_status === 'staged')).toBe(true);
    expect(
      (await obs()).every(
        (o) => o.explicit_rating === null && o.player_type === null,
      ),
    ).toBe(true);
  });
  it('manual match correction is audited/idempotent, then approval and export stay separate from facts', async () => {
    await setup();
    await collect();
    const ambiguous = (await obs()).find(
      (o) => !o.product_match.catalog_product_id,
    )!;
    const p = (
      await db.pool.query<{ product_id: string }>(
        "SELECT product_id FROM catalog_products WHERE slug='ping-g440-sft-driver'",
      )
    ).rows[0]!;
    const d = {
      product_id: p.product_id,
      reason: 'Reviewer verified SFT variant',
      idempotency_key: randomUUID(),
    };
    await correctProductMatch(db, ambiguous.observation_id, d, actor);
    await correctProductMatch(db, ambiguous.observation_id, d, actor);
    const fixed = (await obs()).find(
      (o) => o.observation_id === ambiguous.observation_id,
    )!;
    await approve(fixed);
    expect((await previewExport(db, actor)).eligible).toBe(1);
    expect((await exported()).manifest.count).toBe(1);
    expect(
      (
        await exportLocal(db, {
          actor,
          authorizeLocalExport: true,
          type: 'explicit_rating_candidates',
          directory,
        })
      ).manifest.count,
    ).toBe(0);
    await expect(
      correctProductMatch(
        db,
        ambiguous.observation_id,
        { ...d, idempotency_key: randomUUID() },
        actor,
      ),
    ).rejects.toThrow('staged');
    await setup('manufacturer');
    await collect('demo-manufacturer', mockTransportFor('manufacturer'));
    const fact = (
      await db.pool.query<{ fact_id: string }>(
        'SELECT fact_id FROM manufacturer_facts',
      )
    ).rows[0]!;
    await reviewFact(db, fact.fact_id, 'approve', actor);
    expect((await exported()).manifest.count).toBe(1);
    await suspendSource(db, 'demo-manufacturer', actor);
    expect(
      (await db.pool.query('SELECT review_status FROM manufacturer_facts'))
        .rows[0].review_status,
    ).toBe('revoked');
  });
  it('source reapproval suppresses prior approved versions and recollects into fresh moderation', async () => {
    await setup();
    await collect();
    await approve((await obs()).find((o) => !o.quality_flags.length)!);
    const batch = await exported();
    await approveSourcePolicy(db, 'demo-forum', mockPolicy(), actor);
    expect((await exported()).manifest.count).toBe(0);
    await enableMockSource(db, 'demo-forum', actor);
    await collect();
    expect(
      (await obs()).filter((o) => o.review_status === 'staged'),
    ).toHaveLength(2);
    expect(await retractions(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batch_id: batch.manifest.batch_id }),
      ]),
    );
  });
  it('retention purges metadata, keeps minimal tombstones/audit and prevents replay', async () => {
    await setup();
    await collect();
    const candidate = (await obs()).find((o) => !o.quality_flags.length)!;
    await approve(candidate);
    const batch = await exported();
    await db.pool.query(
      "UPDATE source_items SET first_collected_at=now()-interval '60 days'",
    );
    expect((await purgeExpiredMetadata(db, actor)).purged).toBe(2);
    expect((await purgeExpiredMetadata(db, actor)).purged).toBe(0);
    expect(
      (await obs()).every(
        (o) =>
          o.review_status === 'revoked' &&
          o.source_url.startsWith('https://deleted.invalid/'),
      ),
    ).toBe(true);
    await collect();
    expect(await obs()).toHaveLength(2);
    expect((await exported()).manifest.count).toBe(0);
    expect(await retractions(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batch_id: batch.manifest.batch_id }),
      ]),
    );
  });
  it('concurrent collection claims one source lease, then expired claims resume safely', async () => {
    await setup();
    const t = mockTransportFor('forum');
    await Promise.all([collect('demo-forum', t), collect('demo-forum', t)]);
    expect(t.requests).toHaveLength(2);
    expect(await obs()).toHaveLength(2);
    await db.pool.query(
      "UPDATE sources SET lease_owner=$1,lease_until=now()-interval '1 second' WHERE source_id='demo-forum'",
      [randomUUID()],
    );
    expect((await collect('demo-forum', t)).state).toBe('completed');
    expect(await obs()).toHaveLength(2);
  });
  it('revokes changed structured ratings even when the fixture body is unchanged', async () => {
    await ingest(db, randomUUID());
    const candidate = (
      await db.pool.query<{ payload: Observation }>(
        `SELECT payload FROM observations WHERE payload->>'source_id'='fixture-json' AND payload->'explicit_rating'<>'null'::jsonb AND payload->'quality_flags'='[]'::jsonb LIMIT 1`,
      )
    ).rows[0]!.payload;
    await approve(candidate);
    await enqueue(db, randomUUID());
    while (
      await processNext(db, (s) => {
        const c = fixtureConnector(s);
        return {
          ...c,
          fetchMetadata: (raw: unknown) => {
            const item = c.fetchMetadata(raw);
            return {
              ...item,
              explicit_rating: item.explicit_rating
                ? { ...item.explicit_rating, value: 3 }
                : null,
            };
          },
        };
      })
    ) {
      /* drain */
    }
    const updated = (
      await db.pool.query<{ payload: Observation }>(
        'SELECT payload FROM observations WHERE observation_id=$1',
        [candidate.observation_id],
      )
    ).rows[0]!.payload;
    expect(updated.review_status).toBe('revoked');
    expect(updated.quality_flags).toContain('content_changed');
  });
  it('scheduled collection picks due sources only and reuses durable retry keys', async () => {
    await setup();
    const t = mockTransportFor('forum');
    const results = await collectDue(db, { actor, transport: t });
    expect(results).toHaveLength(1);
    expect(results[0]!.state).toBe('completed');
    expect(await collectDue(db, { actor, transport: t })).toHaveLength(0);
  });
  it('supports multi-category curated catalog records with brand-scoped model identities', async () => {
    for (const [i, type] of [
      'iron',
      'wedge',
      'putter',
      'golf-ball',
      'stand-bag',
      'launch-monitor',
    ].entries())
      await addCatalogProduct(
        db,
        {
          slug: `acme-${type}`,
          brand: `Acme${i}`,
          name: `Acme ${type}`,
          model_number: 'shared-model',
          type,
          category: type === 'launch-monitor' ? 'Tech' : 'Clubs',
          generation: '2026',
          aliases: [`Acme ${type} gear`],
        },
        actor,
      );
    expect(
      (
        await db.pool.query(
          "SELECT * FROM catalog_products WHERE catalog_snapshot_version='curated-phase2'",
        )
      ).rowCount,
    ).toBe(6);
  });
  it('preserves fixture ingestion alongside external observations and uses only isolated tables', async () => {
    await setup();
    await collect();
    await ingest(db, randomUUID());
    expect((await db.pool.query('SELECT * FROM observations')).rowCount).toBe(
      122,
    );
    expect(
      (
        await db.pool.query(
          "SELECT * FROM information_schema.tables WHERE table_name IN ('player_signals','product_scores')",
        )
      ).rowCount,
    ).toBe(0);
  });
});
describe('expanded private administration API', () => {
  it('enforces roles and exposes source, jobs, corrections, facts, export preview and audits', async () => {
    const tokens = {
      admin: 'admin-phase2-abcdefghijklmnopqrstuvwxyz',
      reviewer: 'reviewer-phase2-abcdefghijklmnopqrstuvwxyz',
    };
    const api = app(db, tokens, directory);
    const headers = {
        authorization: `Bearer ${tokens.admin}`,
        'x-tpr-review': '1',
      },
      reader = {
        authorization: `Bearer ${tokens.reviewer}`,
        'x-tpr-review': '1',
      };
    try {
      const def = mockDefinitions.find((s) => s.type === 'forum')!;
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/sources',
            headers: reader,
            payload: def,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/sources',
            headers,
            payload: def,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/sources/demo-forum/policy',
            headers,
            payload: mockPolicy(),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/sources/demo-forum/enable-mock',
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/sources/demo-forum/collect-mock',
            headers,
            payload: { idempotency_key: randomUUID() },
          })
        ).json().state,
      ).toBe('completed');
      for (const url of [
        '/sources',
        '/sources/demo-forum',
        '/sources/demo-forum/events',
        '/jobs',
        '/products',
        '/facts',
        '/exports/history',
      ])
        expect((await api.inject({ url, headers: reader })).statusCode).toBe(
          200,
        );
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/exports/preview',
            headers: reader,
            payload: { type: 'analysis_observations' },
          })
        ).json().eligible,
      ).toBe(0);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/retention/purge',
            headers: reader,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      const html = await api.inject({ url: '/admin', headers: reader });
      expect(html.body).toContain('Source management');
      expect(html.body).toContain('Manufacturer facts');
    } finally {
      await api.close();
    }
  });
});

describe('revision and policy race regression checks', () => {
  it('retains fact revisions and requeues changed specifications for review', async () => {
    await setup('manufacturer');
    await collect('demo-manufacturer', mockTransportFor('manufacturer'));
    const first = (
      await db.pool.query<{ fact_id: string }>(
        'SELECT fact_id FROM manufacturer_facts',
      )
    ).rows[0]!;
    await reviewFact(db, first.fact_id, 'approve', actor);
    const original = mockTransportFor('manufacturer');
    const revised = new MockTransport(async (input) => {
      const response = await original.request(input);
      return { ...response, body: response.body.replace('10.5', '12.5') };
    });
    expect((await collect('demo-manufacturer', revised)).state).toBe(
      'completed',
    );
    const facts = (
      await db.pool.query<{
        review_status: string;
        specifications: { loft_degrees: number };
      }>('SELECT review_status,specifications FROM manufacturer_facts')
    ).rows;
    expect(facts).toHaveLength(2);
    expect(
      facts.find((f) => f.review_status === 'revoked')!.specifications
        .loft_degrees,
    ).toBe(10.5);
    expect(
      facts.find((f) => f.review_status === 'staged')!.specifications
        .loft_degrees,
    ).toBe(12.5);
  });
  it('rechecks permission after a response before persisting or requesting another page', async () => {
    await setup();
    const original = mockTransportFor('forum');
    const t = new MockTransport(async (input) => {
      const r = await original.request(input);
      await db.pool.query(
        `UPDATE source_policies SET expires_at=now()-interval '1 second' WHERE policy_id=(SELECT policy_id FROM sources WHERE source_id='demo-forum')`,
      );
      return r;
    });
    const result = await collect('demo-forum', t);
    expect(result.error_code).toBe('policy_denied');
    expect(t.requests).toHaveLength(1);
    expect(await obs()).toHaveLength(0);
  });
});

describe('upgrade compatibility and generic API registry', () => {
  it('upgrades legacy body-only hashes without revoking unchanged approved fixtures', async () => {
    const { hash, normalize } = await import('../packages/core/identity.js');
    await ingest(db, randomUUID());
    const row = (
      await db.pool.query<{
        payload: Observation;
        item_id: string;
        external_id: string;
      }>(
        `SELECT o.payload,o.item_id,i.external_id FROM observations o JOIN source_items i USING(item_id) WHERE i.source_id='fixture-json' AND o.payload->'quality_flags'='[]'::jsonb LIMIT 1`,
      )
    ).rows[0]!;
    await approve(row.payload);
    const c = fixtureConnector('fixture-json');
    const item = (await c.discover())
      .map((raw) => c.fetchMetadata(raw))
      .find((i) => i.external_id === row.external_id)!;
    await db.pool.query(
      'UPDATE source_items SET content_hash=$2 WHERE item_id=$1',
      [row.item_id, hash(normalize(item.text))],
    );
    await ingest(db, randomUUID());
    expect(
      (
        await db.pool.query<{ payload: Observation }>(
          'SELECT payload FROM observations WHERE observation_id=$1',
          [row.payload.observation_id],
        )
      ).rows[0]!.payload.review_status,
    ).toBe('approved_for_analysis');
  });
  it('supports individually approved generic JSON API sources with the same gates', async () => {
    const def = {
      ...mockDefinitions.find((s) => s.type === 'forum')!,
      source_id: 'demo-api',
      type: 'api',
      url: 'https://mock-golf.example.org/api',
    };
    await registerSource(db, def, actor);
    await approveSourcePolicy(db, 'demo-api', mockPolicy(), actor);
    await enableMockSource(db, 'demo-api', actor);
    expect((await collect('demo-api', mockTransportFor('api'))).state).toBe(
      'completed',
    );
    expect(await obs()).toHaveLength(2);
  });
});
