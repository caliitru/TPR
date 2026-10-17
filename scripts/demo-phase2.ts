import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
} from '../packages/core/sources.js';
import { collectSource } from '../packages/core/collection.js';
import {
  mockDefinitions,
  mockPolicy,
  mockTransportFor,
} from '../packages/connectors/mock-scenarios.js';
import { review } from '../packages/core/moderation.js';
import { exportLocal } from '../packages/adapters/export.js';
const db = database();
const actor = { id: 'phase2-demo-reviewer', role: 'admin' as const };
try {
  await migrate(db);
  await seed(db);
  const results = [];
  for (const def of mockDefinitions) {
    const exists = (
      await db.pool.query('SELECT source_id FROM sources WHERE source_id=$1', [
        def.source_id,
      ])
    ).rowCount;
    if (!exists) {
      await registerSource(db, def, actor);
      await approveSourcePolicy(db, def.source_id, mockPolicy(), actor);
      await enableMockSource(db, def.source_id, actor);
    }
    const transport = mockTransportFor(def.type);
    const first = await collectSource(db, def.source_id, randomUUID(), {
      actor,
      transport,
      force: true,
    });
    const before = (
      await db.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM observations',
      )
    ).rows[0]!.count;
    const repeat = await collectSource(db, def.source_id, randomUUID(), {
      actor,
      transport,
      force: true,
    });
    const after = (
      await db.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM observations',
      )
    ).rows[0]!.count;
    assert.equal(after, before);
    results.push({
      source: def.source_id,
      first,
      repeat,
      http_requests: transport.requests.length,
    });
  }
  const staged = (
    await db.pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM observations WHERE payload->>'source_id'='demo-forum' AND review_status='staged' AND payload->'quality_flags'='[]'::jsonb LIMIT 1`,
    )
  ).rows[0];
  if (staged)
    await review(
      db,
      staged.observation_id,
      {
        action: 'approve',
        reason: 'verified_fixture',
        idempotency_key: randomUUID(),
      },
      actor,
    );
  const exported = await exportLocal(db, {
    actor,
    authorizeLocalExport: true,
    type: 'analysis_observations',
  });
  const counts = (
    await db.pool.query(
      `SELECT (SELECT count(*)::int FROM observations WHERE payload->>'source_id' LIKE 'demo-%') AS mock_observations,(SELECT count(*)::int FROM manufacturer_facts) AS separate_facts`,
    )
  ).rows[0];
  console.log(
    JSON.stringify(
      {
        mode: 'mock-only',
        live_requests: 0,
        results,
        counts,
        local_export: exported,
      },
      null,
      2,
    ),
  );
} finally {
  await db.pool.end();
}
