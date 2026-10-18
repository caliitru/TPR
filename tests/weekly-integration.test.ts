import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
  suspendSource,
} from '../packages/core/sources.js';
import {
  mockDefinitions,
  mockPolicy,
} from '../packages/connectors/mock-scenarios.js';
import {
  MockTransport,
  type HttpRequest,
} from '../packages/connectors/http.js';
import { collectSource } from '../packages/core/collection.js';
import {
  collectWeeklySource,
  runWeekly,
  weeklyTick,
} from '../packages/core/weekly.js';
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error('Disposable test DB required');
const db = database(),
  actor = { id: 'weekly-test-admin', role: 'admin' as const };
const end = new Date('2026-10-11T06:00:00Z'),
  now = new Date('2026-10-12T12:00:00Z');
const id = 'demo-forum';
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.pool.end();
});
beforeEach(async () => {
  await db.pool.query(
    'TRUNCATE weekly_reports,job_events,tombstones,export_batches,review_events,observations,source_items,crawl_jobs,product_aliases,catalog_products,sources,source_policies CASCADE',
  );
  await seed(db);
  await setup();
});
async function setup(source = id) {
  const def = mockDefinitions.find((s) => s.type === 'forum')!;
  await registerSource(
    db,
    {
      ...def,
      source_id: source,
      url: `https://mock-golf.example.org/${source}`,
    },
    actor,
  );
  await approveSourcePolicy(db, source, mockPolicy(), actor);
  await enableMockSource(db, source, actor);
}
function record(change: Record<string, unknown> = {}) {
  return {
    external_id: 'player-1',
    url: 'https://mock-golf.example.org/thread/1',
    published_at: '2026-10-10T12:00:00Z',
    title: 'Ping G440 Max Driver',
    product_label: 'Ping G440 Max Driver',
    kind: 'player',
    body: 'I used this club. Good forgiveness and tight dispersion.',
    ...change,
  };
}
const response = (items: unknown[], next?: string) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ items, ...(next ? { next } : {}) }),
});
const transport = (items: unknown[]) =>
  new MockTransport(() => response(items));
const run = (t: MockTransport, extra: Record<string, unknown> = {}) =>
  collectWeeklySource(db, id, { actor, transport: t, end, now, ...extra });
async function counts() {
  return (
    await db.pool.query(
      `SELECT (SELECT count(*)::int FROM source_items WHERE source_id NOT LIKE 'fixture-%') AS items,(SELECT count(*)::int FROM observations) AS observations`,
    )
  ).rows[0];
}
async function retryNow() {
  await db.pool.query(
    "UPDATE crawl_jobs SET next_retry_at='2000-01-01',lease_until=NULL WHERE state IN ('retry','running')",
  );
  await db.pool.query(
    "UPDATE collection_windows SET next_retry_at='2000-01-01'",
  );
  await db.pool.query('UPDATE sources SET lease_until=NULL');
}
it('collects a bounded seven-day window, persists a report, and reruns without requests or count inflation', async () => {
  const t = transport([
    record(),
    record({ external_id: 'old', published_at: '2020-01-01T00:00:00Z' }),
    record({ external_id: 'undated', published_at: null }),
  ]);
  const options = {
    actor,
    end,
    now,
    sourceIds: [id],
    transportForSource: async () => t,
  };
  const first = await runWeekly(db, options);
  expect(first.metrics.new_records).toBe(1);
  expect(first.metrics.valid_player_observations).toBe(1);
  expect(first.metrics.outside_window).toBe(1);
  expect(first.metrics.undated_records).toBe(1);
  expect(new URL(t.requests[0]!.url).searchParams.get('from')).toBe(
    '2026-10-04T06:00:00.000Z',
  );
  expect(first.total_historical_observations).toBe(1);
  expect(first.observations_awaiting_moderation).toBe(1);
  const second = await runWeekly(db, options);
  expect(second.metrics.new_records ?? 0).toBe(0);
  expect(t.requests).toHaveLength(1);
  expect(await counts()).toEqual({ items: 1, observations: 1 });
});
it('deduplicates IDs, canonical URL variants, content and stable experiences across all history', async () => {
  const first = record({ experience_id: 'experience-1' });
  const result = await run(
    transport([
      first,
      {
        ...first,
        external_id: 'alias-id',
        url: 'https://mock-golf.example.org/thread/1/?utm_source=x#reply',
      },
      {
        ...first,
        external_id: 'syndicated',
        url: 'https://mock-golf.example.org/repost',
      },
    ]),
  );
  expect(result.metrics?.duplicates_skipped).toBe(2);
  expect(await counts()).toEqual({ items: 1, observations: 1 });
  const future = new Date('2026-10-18T06:00:00Z');
  await run(
    transport([
      {
        ...first,
        published_at: '2026-10-17T12:00:00Z',
        external_id: 'new-id',
        url: 'https://mock-golf.example.org/another',
      },
    ]),
    { end: future, now: new Date('2026-10-19T12:00:00Z') },
  );
  expect(await counts()).toEqual({ items: 1, observations: 1 });
});
it('enforces normalized URL, content, experience and observation uniqueness directly in PostgreSQL', async () => {
  await run(transport([record({ experience_id: 'stable' })]));
  const row = (
    await db.pool.query('SELECT * FROM source_items WHERE source_id=$1', [id])
  ).rows[0];
  for (const key of ['url', 'content', 'experience']) {
    await expect(
      db.pool.query(
        `INSERT INTO source_items(item_id,source_id,external_id,canonical_url,published_at,content_hash,rights_policy_id,content_fingerprint,experience_key) VALUES($1,$2,$3,$4,now(),'different',$5,$6,$7)`,
        [
          randomUUID(),
          id,
          randomUUID(),
          key === 'url'
            ? row.canonical_url + '/?utm_source=z#x'
            : 'https://mock-golf.example.org/' + randomUUID(),
          row.rights_policy_id,
          key === 'content' ? row.content_fingerprint : null,
          key === 'experience' ? row.experience_key : null,
        ],
      ),
    ).rejects.toThrow('unique');
  }
  const o = (await db.pool.query('SELECT * FROM observations')).rows[0];
  await expect(
    db.pool.query(
      'INSERT INTO observations(observation_id,item_id,product_id,fingerprint,independence_group_key,payload,export_fields,experience_key,product_key,evidence_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        randomUUID(),
        o.item_id,
        o.product_id,
        randomUUID(),
        o.independence_group_key,
        o.payload,
        o.export_fields,
        o.experience_key,
        o.product_key,
        o.evidence_revision,
      ],
    ),
  ).rejects.toThrow('observation_experience_identity');
});
it('supports distinct product observations and collapses exact syndicated experiences across publishers', async () => {
  const r = record({
    product_labels: [
      'Ping G440 Max Driver',
      'Ping G440 LST Driver',
      'ping g440 max',
    ],
  });
  await run(transport([r]));
  expect(await counts()).toEqual({ items: 1, observations: 2 });
  await setup('second-forum');
  await collectWeeklySource(db, 'second-forum', {
    actor,
    end,
    now,
    transport: transport([
      {
        ...r,
        external_id: 'syndicated',
        url: 'https://mock-golf.example.org/syndicated',
      },
    ]),
  });
  expect(await counts()).toEqual({ items: 2, observations: 2 });
});
it('audits changed records as revisions without duplicating source items', async () => {
  await collectSource(db, id, randomUUID(), {
    actor,
    transport: transport([record({ experience_id: 'fixed' })]),
    force: true,
  });
  const second = await collectSource(db, id, randomUUID(), {
    actor,
    transport: transport([
      record({
        external_id: 'other',
        experience_id: 'fixed',
        url: 'https://mock-golf.example.org/edited',
        body: 'I used this club. Poor forgiveness and wide dispersion.',
      }),
    ]),
    force: true,
  });
  expect(second.state).toBe('completed');
  expect(await counts()).toEqual({ items: 1, observations: 2 });
  expect(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM observations WHERE review_status='revoked'",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM review_events'))
      .rows[0].n,
  ).toBe(1);
});
it('runs a separate one-time five-year backfill and deduplicates weekly collection against it', async () => {
  const t = transport([
    record({
      external_id: 'historic',
      url: 'https://mock-golf.example.org/historic',
      published_at: '2022-01-01T00:00:00Z',
      body: 'I played this club. Good sound.',
    }),
    record(),
  ]);
  const backfill = await run(t, { kind: 'backfill' });
  expect(backfill.state).toBe('completed');
  expect(
    'window_start' in backfill && backfill.window_start?.toISOString(),
  ).toBe('2021-10-11T06:00:00.000Z');
  await run(t);
  expect(await counts()).toEqual({ items: 2, observations: 2 });
  await run(t, {
    kind: 'backfill',
    end: new Date('2026-10-18T06:00:00Z'),
    now: new Date('2026-10-19T00:00:00Z'),
  });
  expect(t.requests).toHaveLength(2);
});
it('recovers missed weeks without gaps and reports the missed run count', async () => {
  await run(transport([record()]));
  const later = new Date('2026-11-01T07:00:00Z');
  const t = transport([
    record({
      external_id: 'missed-week',
      url: 'https://mock-golf.example.org/missed',
      published_at: '2026-10-16T12:00:00Z',
      body: 'I tested this club. Good sound.',
    }),
  ]);
  const report = await runWeekly(db, {
    actor,
    end: later,
    now: new Date('2026-11-02T12:00:00Z'),
    sourceIds: [id],
    transportForSource: async () => t,
  });
  expect(report.missed_runs).toBeGreaterThanOrEqual(2);
  expect(new URL(t.requests[0]!.url).searchParams.get('from')).toBe(
    end.toISOString(),
  );
  expect(await counts()).toEqual({ items: 2, observations: 2 });
});
it('persists partial-page checkpoints and retries without gaps, duplicate evidence or quota bypass', async () => {
  await db.pool.query(
    "UPDATE sources SET settings=jsonb_set(settings,'{max_pages}','1') WHERE source_id=$1",
    [id],
  );
  const t = new MockTransport((req) =>
    new URL(req.url).pathname === '/page2'
      ? response([
          record({
            external_id: 'two',
            url: 'https://mock-golf.example.org/two',
            body: 'I used this club. Good sound.',
          }),
        ])
      : response([record()], 'https://mock-golf.example.org/page2'),
  );
  const first = await run(t);
  expect(first.state).toBe('retry');
  expect(
    (
      await db.pool.query(
        'SELECT weekly_covered_until FROM sources WHERE source_id=$1',
        [id],
      )
    ).rows[0].weekly_covered_until,
  ).toBeNull();
  await retryNow();
  const second = await run(t);
  expect(second.state).toBe('completed');
  expect(t.requests).toHaveLength(2);
  expect(new URL(t.requests[1]!.url).pathname).toBe('/page2');
  expect(await counts()).toEqual({ items: 2, observations: 2 });
});
it('recovers a failed old window and catches up to the current slot in the same weekly run', async () => {
  const bad = new MockTransport(() => ({ status: 500, headers: {}, body: '' }));
  await run(bad);
  await retryNow();
  const later = new Date('2026-10-18T06:00:00Z');
  const t = new MockTransport((req: HttpRequest) => {
    const until = new URL(req.url).searchParams.get('until')!;
    return response([
      record({
        external_id: until,
        url: 'https://mock-golf.example.org/' + until,
        published_at: new Date(Date.parse(until) - 86400000).toISOString(),
        body: 'I used this club. Good sound. ' + until,
      }),
    ]);
  });
  const report = await runWeekly(db, {
    actor,
    end: later,
    now: new Date('2026-10-19T12:00:00Z'),
    sourceIds: [id],
    transportForSource: async () => t,
  });
  expect(report.failed_sources).toHaveLength(0);
  expect(report.sources_checked).toBe(1);
  expect(t.requests).toHaveLength(2);
  expect(
    (
      await db.pool.query(
        'SELECT weekly_covered_until FROM sources WHERE source_id=$1',
        [id],
      )
    ).rows[0].weekly_covered_until.toISOString(),
  ).toBe(later.toISOString());
});
it('prevents concurrent source/window jobs and database-level overlapping unfinished windows', async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const t = new MockTransport(async () => {
    started();
    await wait;
    return response([record()]);
  });
  const first = run(t);
  await began;
  try {
    const other = await run(transport([record()]));
    expect(other.state).toBe('busy');
  } finally {
    release();
  }
  await first;
  expect(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM crawl_jobs WHERE source_id=$1',
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
  await db.pool.query(
    "UPDATE collection_windows SET state='retry' WHERE source_id=$1",
    [id],
  );
  await expect(
    db.pool.query(
      "INSERT INTO collection_windows(window_id,source_id,kind,window_start,window_end) VALUES($1,$2,'weekly','2026-10-10','2026-10-20')",
      [randomUUID(), id],
    ),
  ).rejects.toThrow('one_open_collection_window');
});
it('keeps disabled, suspended, expired and live-mode sources closed and the timer idempotent', async () => {
  const t = transport([record()]);
  await suspendSource(db, id, actor);
  await expect(run(t)).rejects.toThrow();
  expect(t.requests).toHaveLength(0);
  await approveSourcePolicy(db, id, mockPolicy(), actor);
  await enableMockSource(db, id, actor);
  await run(t);
  const options = { actor, now, transportForSource: async () => t };
  expect(await weeklyTick(db, options)).toMatchObject({ sources_checked: 0 });
  expect(await weeklyTick(db, options)).toEqual({ state: 'not_due' });
  expect(t.requests).toHaveLength(1);
  await db.pool.query(
    "UPDATE source_policies SET expires_at=now()-interval '1 second' WHERE policy_id=(SELECT policy_id FROM sources WHERE source_id=$1)",
    [id],
  );
  await expect(run(t)).rejects.toThrow('policy_denied');
  expect(t.requests).toHaveLength(1);
});

it('does not reset a legacy collector cursor or enqueue a weekly job while its lease is active', async () => {
  await db.pool.query(
    `UPDATE sources SET discovery_state='{"next":"https://mock-golf.example.org/legacy-page"}',lease_until=now()+interval '60 seconds' WHERE source_id=$1`,
    [id],
  );
  const t = transport([record()]);
  await expect(run(t)).rejects.toThrow('source_busy');
  expect(
    (
      await db.pool.query(
        'SELECT discovery_state FROM sources WHERE source_id=$1',
        [id],
      )
    ).rows[0].discovery_state.next,
  ).toBe('https://mock-golf.example.org/legacy-page');
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM collection_windows'))
      .rows[0].n,
  ).toBe(0);
  expect(t.requests).toHaveLength(0);
});
it('resumes a crashed window from its committed page and keeps product aliases from creating new revisions', async () => {
  await db.pool.query(
    "UPDATE sources SET settings=jsonb_set(settings,'{max_pages}','1') WHERE source_id=$1",
    [id],
  );
  const t = new MockTransport((req) =>
    new URL(req.url).pathname === '/after-crash'
      ? response([
          record({
            external_id: 'two',
            url: 'https://mock-golf.example.org/two',
            body: 'I played this club. Good sound.',
          }),
        ])
      : response([record()], 'https://mock-golf.example.org/after-crash'),
  );
  await run(t);
  await db.pool.query("UPDATE collection_windows SET state='running'");
  await db.pool.query("UPDATE crawl_jobs SET state='running'");
  await retryNow();
  expect((await run(t)).state).toBe('completed');
  expect(t.requests).toHaveLength(2);
  expect(await counts()).toEqual({ items: 2, observations: 2 });
  await collectSource(db, id, randomUUID(), {
    actor,
    transport: transport([
      record({
        product_label: 'ping g440 max',
        url: 'https://mock-golf.example.org/thread/1?utm_campaign=updated#fragment',
      }),
    ]),
    force: true,
  });
  expect(await counts()).toEqual({ items: 2, observations: 2 });
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM review_events'))
      .rows[0].n,
  ).toBe(0);
});
it('fails closed for unverified window support and permission loss after a response', async () => {
  const t = transport([record()]);
  await db.pool.query(
    "UPDATE sources SET settings=settings-'window_support' WHERE source_id=$1",
    [id],
  );
  await expect(run(t)).rejects.toThrow('window_support_not_verified');
  expect(t.requests).toHaveLength(0);
  await db.pool.query(
    "UPDATE sources SET settings=jsonb_set(settings,'{window_support}','\"complete-feed\"') WHERE source_id=$1",
    [id],
  );
  await expect(run(t, { kind: 'backfill' })).rejects.toThrow(
    'backfill_requires_historical_api',
  );
  await db.pool.query(
    "UPDATE sources SET settings=jsonb_set(settings,'{window_support}','\"bounded-api\"') WHERE source_id=$1",
    [id],
  );
  const revoked = new MockTransport(async () => {
    await db.pool.query(
      "UPDATE source_policies SET expires_at=now()-interval '1 second' WHERE policy_id=(SELECT policy_id FROM sources WHERE source_id=$1)",
      [id],
    );
    return response([record()]);
  });
  expect((await run(revoked)).state).toBe('failed');
  expect(await counts()).toEqual({ items: 0, observations: 0 });
  expect(
    (
      await db.pool.query(
        'SELECT weekly_covered_until FROM sources WHERE source_id=$1',
        [id],
      )
    ).rows[0].weekly_covered_until,
  ).toBeNull();
});

it('prevents manual correction from turning an ambiguous duplicate into a second canonical product experience', async () => {
  await run(
    transport([
      record(),
      record({
        external_id: 'ambiguous-duplicate',
        url: 'https://mock-golf.example.org/ambiguous',
        product_label: 'Ping G440',
      }),
    ]),
  );
  const rows = (
    await db.pool.query('SELECT observation_id,product_id FROM observations')
  ).rows;
  const ambiguous = rows.find((r) => !r.product_id)!,
    matched = rows.find((r) => r.product_id)!;
  const { correctProductMatch } =
    await import('../packages/core/operations.js');
  await expect(
    correctProductMatch(
      db,
      ambiguous.observation_id,
      {
        product_id: matched.product_id,
        reason: 'verified same product',
        idempotency_key: randomUUID(),
      },
      actor,
    ),
  ).rejects.toThrow('observation_experience_identity');
  expect(
    (
      await db.pool.query(
        'SELECT product_id FROM observations WHERE observation_id=$1',
        [ambiguous.observation_id],
      )
    ).rows[0].product_id,
  ).toBeNull();
});

it('counts missed calendar weeks correctly across the spring DST transition', async () => {
  await db.pool.query(
    "UPDATE sources SET weekly_covered_until='2026-03-01T07:00:00Z' WHERE source_id=$1",
    [id],
  );
  const report = await runWeekly(db, {
    actor,
    end: new Date('2026-03-15T06:00:00Z'),
    now: new Date('2026-03-16T12:00:00Z'),
    sourceIds: [id],
    transportForSource: async () =>
      transport([record({ published_at: '2026-03-14T12:00:00Z' })]),
  });
  expect(report.missed_runs).toBe(1);
  expect(report.failed_sources).toHaveLength(0);
});
