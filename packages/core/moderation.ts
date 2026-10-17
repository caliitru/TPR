import { randomUUID } from 'node:crypto';
import {
  observation,
  decision,
  type Decision,
  type Observation,
} from '../contracts/index.js';
import { transaction, type Database } from '../db/client.js';
import { hash } from './identity.js';
import { assertPolicy } from './policy.js';
import { policy } from './pipeline.js';
export interface Actor {
  id: string;
  role: 'reviewer' | 'admin';
}
export function requireActor(actor: Actor, admin = false) {
  if (
    !/^[a-zA-Z0-9_-]{3,80}$/.test(actor.id) ||
    !['reviewer', 'admin'].includes(actor.role) ||
    (admin && actor.role !== 'admin')
  )
    throw new Error('Authorized actor required');
}
export async function review(
  db: Database,
  id: string,
  input: Decision,
  actor: Actor,
): Promise<Observation> {
  requireActor(actor);
  const d = decision.parse(input);
  const requestHash = hash(JSON.stringify({ id, d, actor }));
  return transaction(db, async (c) => {
    // Serialize idempotency key reuse, including keys submitted for different observations.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      d.idempotency_key,
    ]);
    const previous = (
      await c.query<{ request_hash: string }>(
        `SELECT request_hash FROM review_events WHERE idempotency_key=$1`,
        [d.idempotency_key],
      )
    ).rows[0];
    const row = (
      await c.query<{ payload: Observation; review_status: string }>(
        `SELECT * FROM observations WHERE observation_id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('Observation not found');
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new Error('Idempotency key conflict');
      return observation.parse(row.payload);
    }
    const obs = observation.parse(row.payload);
    const next =
      d.action === 'approve'
        ? 'approved_for_analysis'
        : d.action === 'reject'
          ? 'rejected'
          : 'revoked';
    if (!(
      (row.review_status === 'staged' && d.action !== 'revoke') ||
      (row.review_status === 'approved_for_analysis' && d.action === 'revoke')
    ))
      throw new Error('Invalid review transition');
    if (d.action === 'approve') {
      const currentPolicy = await policy(c, obs.source_id);
      assertPolicy(currentPolicy);
      if (currentPolicy.policy_id !== obs.rights_policy_id)
        throw new Error('Source policy version changed; re-review required');
      if (
        !obs.product_match.catalog_product_id ||
        obs.quality_flags.length ||
        obs.observation_kind !== 'first_hand_player_experience'
      )
        throw new Error('Quality gate prevents approval');
      if (
        (
          await c.query(
            `SELECT 1 FROM tombstones t JOIN observations o ON t.item_id=o.item_id OR t.source_id=$2 WHERE o.observation_id=$1`,
            [id, obs.source_id],
          )
        ).rowCount
      )
        throw new Error('Tombstoned observation');
    }
    const updated = observation.parse({
      ...obs,
      review_status: next,
      reviewer_id: actor.id,
      reviewed_at: new Date().toISOString(),
    });
    await c.query(
      'UPDATE observations SET review_status=$2,payload=$3 WHERE observation_id=$1',
      [id, next, updated],
    );
    await c.query(
      `INSERT INTO review_events(event_id,observation_id,actor_id,prior_status,new_status,reason,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        id,
        actor.id,
        row.review_status,
        next,
        d.reason,
        d.idempotency_key,
        requestHash,
      ],
    );
    if (next === 'revoked')
      await c.query(
        `UPDATE export_batches SET retraction_required=true WHERE $1::uuid=ANY(observation_ids)`,
        [id],
      );
    return updated;
  });
}
export async function suppress(
  db: Database,
  target: { source_id?: string; item_id?: string },
  reason: string,
  actor: Actor,
) {
  requireActor(actor, true);
  if (
    (!target.source_id && !target.item_id) ||
    (target.source_id && target.item_id) ||
    !reason.trim() ||
    reason.length > 200
  )
    throw new Error('One target and a concise reason required');
  return transaction(db, async (c) => {
    if (target.source_id) {
      const s = await c.query(
        'SELECT source_id FROM sources WHERE source_id=$1 FOR UPDATE',
        [target.source_id],
      );
      if (!s.rowCount) throw new Error('Source not found');
      await c.query(`UPDATE sources SET enabled=false WHERE source_id=$1`, [
        target.source_id,
      ]);
    }
    const rows = (
      await c.query<{
        observation_id: string;
        review_status: string;
        payload: Observation;
      }>(
        `SELECT o.* FROM observations o JOIN source_items i USING(item_id) WHERE ($1::text IS NOT NULL AND i.source_id=$1) OR ($2::uuid IS NOT NULL AND i.item_id=$2) FOR UPDATE OF o`,
        [target.source_id ?? null, target.item_id ?? null],
      )
    ).rows;
    await c.query(
      `INSERT INTO tombstones(tombstone_id,source_id,item_id,reason,actor_id) VALUES($1,$2,$3,$4,$5)`,
      [
        randomUUID(),
        target.source_id ?? null,
        target.item_id ?? null,
        reason,
        actor.id,
      ],
    );
    for (const row of rows) {
      if (row.review_status === 'revoked') continue;
      const updated = observation.parse({
        ...row.payload,
        review_status: 'revoked',
        reviewer_id: actor.id,
        reviewed_at: new Date().toISOString(),
      });
      await c.query(
        `UPDATE observations SET review_status='revoked',payload=$2 WHERE observation_id=$1`,
        [row.observation_id, updated],
      );
      const key = randomUUID();
      await c.query(
        `INSERT INTO review_events(event_id,observation_id,actor_id,prior_status,new_status,reason,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'revoked',$5,$6,$7)`,
        [
          randomUUID(),
          row.observation_id,
          actor.id,
          row.review_status,
          'takedown',
          key,
          hash(key),
        ],
      );
    }
    const ids = rows.map((r) => r.observation_id);
    await c.query(
      `UPDATE export_batches SET retraction_required=true WHERE observation_ids && $1::uuid[]`,
      [ids],
    );
    return {
      suppressed: ids.length,
      retractions: (
        await c.query(
          'SELECT batch_id FROM export_batches WHERE retraction_required=true',
        )
      ).rows,
    };
  });
}
