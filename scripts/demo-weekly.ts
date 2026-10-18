import assert from 'node:assert/strict';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import {
  mockDefinitions,
  mockPolicy,
} from '../packages/connectors/mock-scenarios.js';
import { MockTransport } from '../packages/connectors/http.js';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
} from '../packages/core/sources.js';
import { runWeekly, weeklySlot } from '../packages/core/weekly.js';
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error(
    'Weekly demonstration requires explicitly selected disposable test database',
  );
const db = database(),
  actor = { id: 'weekly-demo-admin', role: 'admin' as const },
  source = 'weekly-demo-forum';
try {
  await migrate(db);
  await seed(db);
  const def = mockDefinitions.find((s) => s.type === 'forum')!;
  if (
    !(await db.pool.query('SELECT 1 FROM sources WHERE source_id=$1', [source]))
      .rowCount
  ) {
    await registerSource(
      db,
      {
        ...def,
        source_id: source,
        url: 'https://mock-golf.example.org/weekly-demo',
      },
      actor,
    );
    await approveSourcePolicy(db, source, mockPolicy(), actor);
    await enableMockSource(db, source, actor);
  }
  const now = new Date(),
    end = weeklySlot(now),
    previous = new Date(end.getTime() - 7 * 86400000);
  const record = (id: string, date: Date, product: string, body: string) => ({
    external_id: id,
    url: 'https://mock-golf.example.org/weekly-demo/' + id,
    published_at: date.toISOString(),
    title: product,
    product_label: product,
    kind: 'player',
    body,
  });
  const items = [
    record(
      'historic',
      new Date(previous.getTime() - 365 * 86400000),
      'Ping G430 Max Driver',
      'I played this club. Good sound in this synthetic backfill.',
    ),
    record(
      'previous',
      new Date(previous.getTime() - 86400000),
      'Ping G440 Max Driver',
      'I used this club. Good forgiveness in a synthetic prior experience.',
    ),
    record(
      'weekly',
      new Date(end.getTime() - 86400000),
      'Ping G440 LST Driver',
      'I tested this club. Tight dispersion in a synthetic current experience.',
    ),
  ];
  items.push({
    ...items[2]!,
    external_id: 'weekly-repost',
    url: 'https://mock-golf.example.org/weekly-demo/repost',
  });
  const transport = new MockTransport(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ items }),
  }));
  const options = {
    actor,
    now,
    sourceIds: [source],
    transportForSource: async () => transport,
  };
  const backfill = await runWeekly(db, {
    ...options,
    end: previous,
    kind: 'backfill',
  });
  const weekly = await runWeekly(db, { ...options, end });
  const requests = transport.requests.length;
  const repeat = await runWeekly(db, { ...options, end });
  assert.equal(transport.requests.length, requests);
  assert.equal(repeat.metrics.new_records, 0);
  assert.equal(repeat.failed_sources.length, 0);
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        scheduler_deployed: false,
        live_requests: 0,
        backfill,
        weekly,
        repeat,
      },
      null,
      2,
    ),
  );
} finally {
  await db.pool.end();
}
