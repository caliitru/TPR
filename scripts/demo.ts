import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import { ingest } from '../packages/core/pipeline.js';
import { review } from '../packages/core/moderation.js';
import { exportLocal } from '../packages/adapters/export.js';
const db = database();
try {
  await migrate(db);
  const seeded = await seed(db);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await ingest(db, randomUUID()));
  const counts = (
    await db.pool.query(
      `SELECT (SELECT count(*)::int FROM source_items) AS items,(SELECT count(*)::int FROM observations) AS observations,(SELECT count(*)::int FROM observations WHERE product_id IS NULL) AS unresolved`,
    )
  ).rows[0] as { items: number; observations: number; unresolved: number };
  assert.equal(counts.observations, 120);
  assert.equal(counts.items, 123);
  assert.equal(counts.unresolved, 12);
  const actor = { id: 'demo-reviewer', role: 'admin' as const };
  const staged = (
    await db.pool.query<{ observation_id: string }>(
      `SELECT observation_id FROM observations WHERE review_status='staged' AND payload->'quality_flags'='[]'::jsonb ORDER BY (payload->'product_match'->>'candidate_label'='Ping G440 Max Driver') DESC,(payload->'explicit_rating' <> 'null'::jsonb) DESC,observation_id LIMIT 2`,
    )
  ).rows;
  const decisions = [];
  for (const [i, row] of staged.entries())
    decisions.push(
      await review(
        db,
        row.observation_id,
        {
          action: i === 0 ? 'approve' : 'reject',
          reason: i === 0 ? 'verified_fixture' : 'insufficient_evidence',
          idempotency_key: randomUUID(),
        },
        actor,
      ),
    );
  const analysis = await exportLocal(db, {
    actor,
    authorizeLocalExport: true,
    type: 'analysis_observations',
  });
  const ratings = await exportLocal(db, {
    actor,
    authorizeLocalExport: true,
    type: 'explicit_rating_candidates',
  });
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        seeded,
        runs,
        counts,
        decisions: decisions.map((o) => ({
          id: o.observation_id,
          status: o.review_status,
          product: o.product_match.candidate_label,
        })),
        analysis,
        ratings,
      },
      null,
      2,
    ),
  );
} finally {
  await db.pool.end();
}
