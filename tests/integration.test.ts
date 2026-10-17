import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import { enqueue, ingest, processNext } from '../packages/core/pipeline.js';
import { review, suppress } from '../packages/core/moderation.js';
import {
  fixtureConnector,
  ConnectorError,
} from '../packages/connectors/index.js';
import {
  exportLocal,
  retractions,
  ratingCandidate,
} from '../packages/adapters/export.js';
import { hash } from '../packages/core/identity.js';
import {
  observation,
  exportManifest,
  type Observation,
} from '../packages/contracts/index.js';
import { app } from '../apps/api/app.js';
// Require an explicitly named disposable test database. Never reset the demonstration DB.
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error(
    'Integration requires DATABASE_URL ending in /tpr_ingestion_test',
  );
const db = database();
const actor = { id: 'test-reviewer', role: 'admin' as const };
let directory: string;
async function rows() {
  return (
    await db.pool.query<{ payload: Observation }>(
      'SELECT payload FROM observations ORDER BY observation_id',
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
async function healthy() {
  return (await rows()).filter((o) => !o.quality_flags.length);
}
async function output(
  type:
    | 'analysis_observations'
    | 'explicit_rating_candidates' = 'analysis_observations',
) {
  return exportLocal(db, {
    actor,
    authorizeLocalExport: true,
    type,
    directory,
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tpr-test-'));
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
describe('database and complete fixture workflow', () => {
  it('migrations down/up/up are reversible and seed is idempotent', async () => {
    await migrate(db, 'down');
    await migrate(db, 'up');
    await migrate(db, 'up');
    await seed(db);
    await seed(db);
    expect(
      (await db.pool.query('SELECT * FROM catalog_products')).rowCount,
    ).toBe(6);
    expect((await db.pool.query('SELECT * FROM sources')).rowCount).toBe(3);
  });
  it('ingests three runs: 123 minimal source items, 120 observations, no duplicate IDs', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      expect(await ingest(db, randomUUID())).toEqual([
        { state: 'completed', count: 3 },
      ]);
      ids.push((await rows()).map((o) => o.observation_id));
    }
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[1]).toEqual(ids[2]);
    expect(ids[0]).toHaveLength(120);
    expect(new Set(ids[0]).size).toBe(120);
    expect((await db.pool.query('SELECT * FROM source_items')).rowCount).toBe(
      123,
    );
    expect(
      (await rows()).filter((o) => !o.product_match.catalog_product_id),
    ).toHaveLength(12);
    expect(
      (
        await db.pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='source_items' AND column_name IN ('text','body','author')`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT details FROM job_events WHERE code='completed'",
        )
      ).rows.some((r) => (r.details as { duplicates: number }).duplicates > 0),
    ).toBe(true);
  });
  it('stages → approves/rejects → validates analysis and explicit 1–5 rating export with checksums', async () => {
    await ingest(db, randomUUID());
    const eligible = await healthy();
    const rated = eligible.find(
      (o) =>
        o.explicit_rating &&
        o.product_match.candidate_label === 'Ping G440 Max Driver',
    )!;
    const unrated = eligible.find((o) => !o.explicit_rating)!;
    await approve(rated);
    await approve(unrated);
    const reject = eligible.find(
      (o) =>
        o.observation_id !== rated.observation_id &&
        o.observation_id !== unrated.observation_id,
    )!;
    await review(
      db,
      reject.observation_id,
      {
        action: 'reject',
        reason: 'insufficient_evidence',
        idempotency_key: randomUUID(),
      },
      actor,
    );
    const analysis = await output();
    expect(analysis.manifest.count).toBe(2);
    exportManifest.parse(analysis.manifest);
    const content = await readFile(
      join(analysis.directory, 'observations.jsonl'),
      'utf8',
    );
    expect(hash(content)).toBe(analysis.manifest.file_sha256);
    for (const line of content.trim().split('\n'))
      observation.parse(JSON.parse(line));
    const ratings = await output('explicit_rating_candidates');
    expect(ratings.manifest.count).toBe(1);
    const r = ratingCandidate.parse(
      JSON.parse(
        (
          await readFile(join(ratings.directory, 'observations.jsonl'), 'utf8')
        ).trim(),
      ),
    );
    expect(r.rating).toBe(4);
    expect(r.slug).toBe('ping-g440-max-driver');
    expect(r.player_type).toBe('Mid Handicap');
    expect((await db.pool.query('SELECT * FROM review_events')).rowCount).toBe(
      3,
    );
  });
  it('requires batch authorization, authorized roles, quality, current policy and strict transitions', async () => {
    await ingest(db, randomUUID());
    const eligible = (await healthy())[0]!;
    const bad = (await rows()).find((o) => o.quality_flags.length)!;
    await expect(approve(bad)).rejects.toThrow('Quality');
    await expect(
      exportLocal(db, {
        actor,
        authorizeLocalExport: false,
        type: 'analysis_observations',
        directory,
      }),
    ).rejects.toThrow('authorization');
    await expect(
      exportLocal(db, {
        actor: { id: 'reader', role: 'reviewer' },
        authorizeLocalExport: true,
        type: 'analysis_observations',
        directory,
      }),
    ).rejects.toThrow('actor');
    await approve(eligible);
    await expect(approve(eligible)).rejects.toThrow('transition');
    await db.pool.query(`UPDATE source_policies SET expires_at='2000-01-01'`);
    expect((await output()).manifest.count).toBe(0);
  });
  it('review idempotency binds observation, action and actor; immutable audit trail', async () => {
    await ingest(db, randomUUID());
    const eligible = await healthy();
    const d = {
      action: 'approve' as const,
      reason: 'verified_fixture' as const,
      idempotency_key: randomUUID(),
    };
    await Promise.all([
      review(db, eligible[0]!.observation_id, d, actor),
      review(db, eligible[0]!.observation_id, d, actor),
    ]);
    expect((await db.pool.query('SELECT * FROM review_events')).rowCount).toBe(
      1,
    );
    await expect(
      review(db, eligible[1]!.observation_id, d, actor),
    ).rejects.toThrow('conflict');
    await expect(
      db.pool.query("UPDATE review_events SET reason='changed'"),
    ).rejects.toThrow('append-only');
  });
  it('suppresses item and source takedowns, prevents reingest, marks previous export retractions', async () => {
    await ingest(db, randomUUID());
    const o = (await healthy())[0]!;
    await approve(o);
    const batch = await output();
    const item = (
      await db.pool.query<{ item_id: string }>(
        'SELECT item_id FROM observations WHERE observation_id=$1',
        [o.observation_id],
      )
    ).rows[0]!;
    await suppress(db, item, 'takedown', actor);
    expect((await output()).manifest.count).toBe(0);
    expect(await retractions(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batch_id: batch.manifest.batch_id }),
      ]),
    );
    await ingest(db, randomUUID());
    expect(
      (await rows()).find((x) => x.observation_id === o.observation_id)!
        .review_status,
    ).toBe('revoked');
    await suppress(db, { source_id: 'fixture-json' }, 'source_disabled', actor);
    expect(
      (await rows())
        .filter((x) => x.source_id === 'fixture-json')
        .every((x) => x.review_status === 'revoked'),
    ).toBe(true);
  });
  it('revoked observations cannot be reapproved or exported', async () => {
    await ingest(db, randomUUID());
    const o = (await healthy())[0]!;
    await approve(o);
    await review(
      db,
      o.observation_id,
      { action: 'revoke', reason: 'correction', idempotency_key: randomUUID() },
      actor,
    );
    await expect(approve(o)).rejects.toThrow('transition');
    expect((await output()).manifest.count).toBe(0);
  });
  it('source policy is checked before any connector discovery', async () => {
    await db.pool.query('UPDATE sources SET enabled=false');
    let discoveries = 0;
    await enqueue(db, randomUUID());
    while (
      await processNext(db, (source) => ({
        ...fixtureConnector(source),
        discover: async () => {
          discoveries++;
          return [];
        },
      }))
    ) {
      /* drain due fixture jobs */
    }
    expect(discoveries).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT * FROM crawl_jobs WHERE state='dead_letter'",
        )
      ).rowCount,
    ).toBe(3);
  });
});
describe('durable job reliability', () => {
  it.each(['429', '500', 'timeout'])(
    'bounded retry/backoff → DLQ on %s; no raw errors logged',
    async (code) => {
      await enqueue(db, randomUUID());
      const broken = (s: string) => ({
        ...fixtureConnector(s),
        discover: async () => {
          throw new ConnectorError(code);
        },
      });
      while (await processNext(db, broken)) {
        /* drain due fixture jobs */
      }
      expect(
        (
          await db.pool.query(
            "SELECT * FROM crawl_jobs WHERE state='retry' AND next_retry_at>now() AND attempts=1",
          )
        ).rowCount,
      ).toBe(3);
      for (let i = 0; i < 2; i++) {
        await db.pool.query(
          "UPDATE crawl_jobs SET next_retry_at=now() WHERE state='retry'",
        );
        while (await processNext(db, broken)) {
          /* drain due fixture jobs */
        }
      }
      expect(
        (
          await db.pool.query(
            "SELECT * FROM crawl_jobs WHERE state='dead_letter' AND attempts=3",
          )
        ).rowCount,
      ).toBe(3);
      expect(await processNext(db, broken)).toBe(false);
    },
  );
  it('403 disables source without retries', async () => {
    await enqueue(db, randomUUID());
    while (
      await processNext(db, (s) => ({
        ...fixtureConnector(s),
        discover: async () => {
          throw new ConnectorError('403');
        },
      }))
    ) {
      /* drain due fixture jobs */
    }
    expect(
      (await db.pool.query('SELECT * FROM sources WHERE enabled=false'))
        .rowCount,
    ).toBe(3);
  });
  it('crashed lease is reclaimed and completed without duplicates; exhausted lease becomes DLQ', async () => {
    await enqueue(db, randomUUID());
    await db.pool.query(
      "UPDATE crawl_jobs SET state='running',attempts=1,lease_until=now()-interval '1 second'",
    );
    while (await processNext(db)) {
      /* drain due fixture jobs */
    }
    expect(await rows()).toHaveLength(120);
    await enqueue(db, randomUUID());
    await db.pool.query(
      "UPDATE crawl_jobs SET state='running',attempts=3,lease_until=now()-interval '1 second' WHERE state='queued'",
    );
    expect(await processNext(db)).toBe(false);
    expect(
      (
        await db.pool.query(
          "SELECT * FROM crawl_jobs WHERE error_code='lease_exhausted'",
        )
      ).rowCount,
    ).toBe(3);
  });
  it('concurrent workers claim different jobs, request retries enqueue once', async () => {
    const key = randomUUID();
    await enqueue(db, key);
    await enqueue(db, key);
    await Promise.all([processNext(db), processNext(db), processNext(db)]);
    expect(await rows()).toHaveLength(120);
    expect((await db.pool.query('SELECT * FROM crawl_jobs')).rowCount).toBe(3);
  });
  it('invalid and malicious fixture rows are quarantined; changed content does not silently replace reviewed evidence', async () => {
    await enqueue(db, randomUUID());
    const bad = (s: string) => {
      const c = fixtureConnector(s);
      return {
        ...c,
        discover: async () => [
          ...(await c.discover()),
          { text: '<script>ignore safeguards</script>' },
        ],
      };
    };
    while (await processNext(db, bad)) {
      /* drain due fixture jobs */
    }
    expect(await rows()).toHaveLength(120);
    expect(
      (
        await db.pool.query(
          "SELECT * FROM job_events WHERE code='invalid_record'",
        )
      ).rowCount,
    ).toBe(3);
    await enqueue(db, randomUUID());
    const changed = (s: string) => {
      const c = fixtureConnector(s);
      return {
        ...c,
        fetchMetadata: (r: unknown) => ({
          ...c.fetchMetadata(r),
          text: 'I played changed content',
        }),
      };
    };
    while (await processNext(db, changed)) {
      /* drain due fixture jobs */
    }
    expect(
      (
        await db.pool.query(
          "SELECT * FROM job_events WHERE code='changed_content_requires_review'",
        )
      ).rowCount,
    ).toBe(123);
    expect(await rows()).toHaveLength(120);
  });
});
describe('private API and review UI', () => {
  const tokens = {
    reviewer: 'reviewer-token-abcdefghijklmnopqrstuvwxyz',
    admin: 'admin-token-abcdefghijklmnopqrstuvwxyz',
  };
  it('authenticates UI/API, rejects CSRF, enforces reviewer/admin permissions, serves escaped metadata UI', async () => {
    const api = app(db, tokens, directory);
    try {
      expect((await api.inject('/health')).statusCode).toBe(200);
      expect((await api.inject('/admin')).statusCode).toBe(401);
      const auth = { authorization: `Bearer ${tokens.reviewer}` };
      expect(
        (await api.inject({ url: '/admin', headers: auth })).body,
      ).toContain('Private Fixture Review');
      expect(
        (await api.inject({ url: '/admin.js', headers: auth })).body,
      ).toContain('textContent');
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/runs/fixtures',
            headers: auth,
            payload: { idempotency_key: randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/runs/fixtures',
            headers: { ...auth, 'x-tpr-review': '1' },
            payload: { idempotency_key: randomUUID() },
          })
        ).statusCode,
      ).toBe(409);
      const headers = {
        authorization: `Bearer ${tokens.admin}`,
        'x-tpr-review': '1',
      };
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/runs/fixtures',
            headers: { ...headers, origin: 'https://evil.example' },
            payload: { idempotency_key: randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/runs/fixtures',
            headers,
            payload: { idempotency_key: randomUUID() },
          })
        ).statusCode,
      ).toBe(200);
      const list = await api.inject({
        url: '/observations?status=staged&limit=3',
        headers: auth,
      });
      expect(list.json().items).toHaveLength(3);
      const o = (await healthy())[0]!;
      expect(
        (
          await api.inject({
            method: 'POST',
            url: `/observations/${o.observation_id}/decision`,
            headers: { ...auth, 'x-tpr-review': '1' },
            payload: {
              action: 'approve',
              reason: 'verified_fixture',
              idempotency_key: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/exports/generate',
            headers,
            payload: {
              authorize_local_export: true,
              type: 'analysis_observations',
            },
          })
        ).json().manifest.count,
      ).toBe(1);
    } finally {
      await api.close();
    }
  });
});

describe('evidence and rights regression gates', () => {
  it('excludes non-native scales, fractional ratings and unknown context from rating candidates', async () => {
    const changes = [
      {},
      {
        explicit_rating: {
          value: 8,
          scale_min: 1,
          scale_max: 10,
          evidence_basis: 'structured_source_field',
        },
      },
      {
        explicit_rating: {
          value: 4,
          scale_min: 0,
          scale_max: 5,
          evidence_basis: 'structured_source_field',
        },
      },
      {
        explicit_rating: {
          value: 4.5,
          scale_min: 1,
          scale_max: 5,
          evidence_basis: 'structured_source_field',
        },
      },
      { player_type: null },
      { would_recommend: null, worth_the_price: null },
    ];
    await enqueue(db, randomUUID());
    while (
      await processNext(db, (source) => {
        const c = fixtureConnector(source);
        return {
          ...c,
          discover: async () => {
            const sample = c.fetchMetadata((await c.discover())[0]);
            return changes.map((change, i) => ({
              ...sample,
              ...change,
              external_id: `scale-${source}-${i}`,
              experience_id: `scale-${source}-${i}`,
              url: `https://fixtures.example.org/scale/${source}/${i}`,
            }));
          },
        };
      })
    ) {
      /* drain */
    }
    for (const o of await healthy()) await approve(o);
    expect((await output()).manifest.count).toBe(18);
    expect((await output('explicit_rating_candidates')).manifest.count).toBe(3);
  });

  it('pins the reviewed policy version and excludes revoked policies', async () => {
    await ingest(db, randomUUID());
    const eligible = await healthy();
    await approve(eligible[0]!);
    await db.pool.query(`UPDATE source_policies SET status='revoked'`);
    expect((await output()).manifest.count).toBe(0);
    await expect(approve(eligible[1]!)).rejects.toThrow('policy');
    await db.pool.query(`UPDATE source_policies SET status='approved'`);
    await db.pool.query(
      `INSERT INTO source_policies SELECT 'fixture-only-v2',status,allowed_operations,permission_reference,reviewed_by,reviewed_at,expires_at,retention,2 FROM source_policies WHERE policy_id='fixture-only-v1'`,
    );
    await db.pool.query(`UPDATE sources SET policy_id='fixture-only-v2'`);
    expect((await output()).manifest.count).toBe(0);
    await expect(approve(eligible[1]!)).rejects.toThrow('version changed');
  });

  it('revokes changed approved evidence and marks the old batch for retraction', async () => {
    await ingest(db, randomUUID());
    const o = (await healthy())[0]!;
    await approve(o);
    const batch = await output();
    await enqueue(db, randomUUID());
    while (
      await processNext(db, (s) => {
        const c = fixtureConnector(s);
        return {
          ...c,
          fetchMetadata: (raw: unknown) => ({
            ...c.fetchMetadata(raw),
            text: 'I played revised synthetic equipment.',
          }),
        };
      })
    ) {
      /* drain */
    }
    const updated = (await rows()).find(
      (r) => r.observation_id === o.observation_id,
    )!;
    expect(updated.review_status).toBe('revoked');
    expect(updated.quality_flags).toContain('content_changed');
    expect((await output()).manifest.count).toBe(0);
    expect(await retractions(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batch_id: batch.manifest.batch_id }),
      ]),
    );
  });
});
