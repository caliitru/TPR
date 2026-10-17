import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Database } from '../db/client.js';
import { requireActor, suppress, type Actor } from './moderation.js';
import { catalogRecord, intelligentProductId } from './intelligence.js';
import { hash, normalize, stableId } from './identity.js';
import { observation, type Observation } from '../contracts/index.js';
import { sourceEvent, readSource, assertSource } from './sources.js';
export async function addCatalogProduct(
  db: Database,
  input: unknown,
  actor: Actor,
) {
  requireActor(actor, true);
  const p = catalogRecord.parse(input);
  const id = intelligentProductId(p.slug);
  return transaction(db, async (c) => {
    await c.query(
      `INSERT INTO catalog_products(product_id,slug,brand,name,model_number,category,type,catalog_snapshot_version,generation,family,variant,configurations,brand_aliases) VALUES($1,$2,$3,$4,$5,$6,$7,'curated-phase2',$8,$9,$10,$11,$12)`,
      [
        id,
        p.slug,
        p.brand,
        p.name,
        p.model_number,
        p.category,
        p.type,
        p.generation,
        p.family,
        p.variant,
        p.configurations,
        p.brand_aliases,
      ],
    );
    for (const alias of p.aliases)
      await c.query(
        `INSERT INTO product_aliases VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          stableId(`alias:${id}:${normalize(alias)}`),
          id,
          normalize(alias),
          `curated:${actor.id}`,
        ],
      );
    return { product_id: id };
  });
}
export const productCorrection = z.strictObject({
  product_id: z.uuid(),
  reason: z.string().min(5).max(200),
  idempotency_key: z.string().min(8).max(128),
});
export async function correctProductMatch(
  db: Database,
  id: string,
  input: unknown,
  actor: Actor,
) {
  requireActor(actor);
  const d = productCorrection.parse(input);
  const signature = hash(JSON.stringify({ id, d, actor }));
  return transaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      d.idempotency_key,
    ]);
    const previous = (
      await c.query<{ request_hash: string }>(
        'SELECT request_hash FROM review_events WHERE idempotency_key=$1',
        [d.idempotency_key],
      )
    ).rows[0];
    const row = (
      await c.query<{ payload: Observation; review_status: string }>(
        'SELECT * FROM observations WHERE observation_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('Observation not found');
    if (previous) {
      if (previous.request_hash !== signature)
        throw new Error('Idempotency key conflict');
      return row.payload;
    }
    if (row.review_status !== 'staged')
      throw new Error('Only staged observations may be corrected');
    const product = (
      await c.query<{ name: string }>(
        'SELECT name FROM catalog_products WHERE product_id=$1',
        [d.product_id],
      )
    ).rows[0];
    if (!product) throw new Error('Product not found');
    const payload = observation.parse({
      ...row.payload,
      product_match: {
        catalog_product_id: d.product_id,
        candidate_label: product.name,
        confidence: 1,
        method: 'contextual',
      },
      quality_flags: row.payload.quality_flags.filter(
        (f) => f !== 'ambiguous_product',
      ),
    });
    await c.query(
      'UPDATE observations SET product_id=$2,payload=$3 WHERE observation_id=$1',
      [id, d.product_id, payload],
    );
    await c.query(
      `INSERT INTO review_events(event_id,observation_id,actor_id,prior_status,new_status,reason,idempotency_key,request_hash) VALUES($1,$2,$3,'staged','staged',$4,$5,$6)`,
      [
        randomUUID(),
        id,
        actor.id,
        `product_correction:${d.reason}`,
        d.idempotency_key,
        signature,
      ],
    );
    return payload;
  });
}
export async function reviewFact(
  db: Database,
  id: string,
  action: 'approve' | 'reject' | 'revoke',
  actor: Actor,
) {
  requireActor(actor);
  return transaction(db, async (c) => {
    const fact = (
      await c.query<{
        item_id: string;
        policy_id: string;
        review_status: string;
        product_id: string | null;
        source_id: string;
      }>(
        `SELECT f.*,i.source_id FROM manufacturer_facts f JOIN source_items i USING(item_id) WHERE fact_id=$1 FOR UPDATE OF f`,
        [id],
      )
    ).rows[0];
    if (!fact) throw new Error('Fact not found');
    if (!(
      (fact.review_status === 'staged' && action !== 'revoke') ||
      (fact.review_status === 'approved_for_analysis' && action === 'revoke')
    ))
      throw new Error('Invalid fact transition');
    if (action === 'approve') {
      const source = await readSource(c, fact.source_id);
      assertSource(source, 'mock');
      if (
        source.policy_id !== fact.policy_id ||
        !source.allowed_operations.manufacturer_facts ||
        !fact.product_id
      )
        throw new Error('Fact policy or product mismatch');
    }
    const status =
      action === 'approve'
        ? 'approved_for_analysis'
        : action === 'reject'
          ? 'rejected'
          : 'revoked';
    await c.query(
      'UPDATE manufacturer_facts SET review_status=$2 WHERE fact_id=$1',
      [id, status],
    );
    await sourceEvent(c, fact.source_id, actor.id, 'fact_reviewed', {
      fact_id: id,
      prior_status: fact.review_status,
      new_status: status,
    });
    return { fact_id: id, review_status: status };
  });
}
export async function purgeExpiredMetadata(db: Database, actor: Actor) {
  requireActor(actor, true);
  const items = (
    await db.pool.query<{ item_id: string }>(
      `SELECT i.item_id FROM source_items i JOIN source_policies p ON p.policy_id=i.rights_policy_id WHERE i.purged_at IS NULL AND i.first_collected_at<now()-((p.retention->>'metadata_days')::int*interval '1 day') ORDER BY i.item_id LIMIT 500`,
    )
  ).rows;
  for (const { item_id: id } of items) {
    await suppress(db, { item_id: id }, 'retention_expired', actor);
    await transaction(db, async (c) => {
      const existing = (
        await c.query<{ source_id: string }>(
          'SELECT source_id FROM source_items WHERE item_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      const rows = (
        await c.query<{ observation_id: string; payload: Observation }>(
          'SELECT observation_id,payload FROM observations WHERE item_id=$1 FOR UPDATE',
          [id],
        )
      ).rows;
      for (const row of rows) {
        const payload = observation.parse({
          ...row.payload,
          source_url: `https://deleted.invalid/item/${id}`,
          source_item_id: `deleted-${id}`,
          published_at: null,
          source_content_hash: null,
          product_match: {
            ...row.payload.product_match,
            candidate_label: 'retained-tombstone',
          },
        });
        await c.query(
          'UPDATE observations SET payload=$2,export_fields=$3 WHERE observation_id=$1',
          [
            row.observation_id,
            payload,
            { would_recommend: null, worth_the_price: null },
          ],
        );
        await c.query(
          `UPDATE observation_evidence SET attributes='[]',provenance='{"deleted":true}' WHERE observation_id=$1`,
          [row.observation_id],
        );
      }
      await c.query(
        `UPDATE manufacturer_facts SET specifications='{}',model=NULL,variant=NULL,release_date=NULL,review_status='revoked' WHERE item_id=$1`,
        [id],
      );
      await c.query(
        `UPDATE source_items SET canonical_url=$2,external_id=$3,content_hash=$4,published_at=NULL,purged_at=now() WHERE item_id=$1`,
        [
          id,
          `https://deleted.invalid/item/${id}`,
          `deleted-${id}`,
          hash(`deleted:${id}`),
        ],
      );
      await sourceEvent(c, existing.source_id, actor.id, 'metadata_purged', {
        item_id: id,
      });
    });
  }
  return { purged: items.length, more_may_remain: items.length === 500 };
}
