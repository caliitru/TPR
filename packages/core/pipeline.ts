import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type Database } from '../db/client.js';
import {
  fixtureConnector,
  fixtureSources,
  ConnectorError,
  type Connector,
} from '../connectors/index.js';
import { assertPolicy, type Policy } from './policy.js';
import { extract } from './extraction.js';
import { hash, normalize, stableId, canonicalUrl } from './identity.js';
import type { Product } from './catalog.js';
import {
  observation,
  type Observation,
  type SourceItem,
} from '../contracts/index.js';
export async function catalog(c: pg.PoolClient): Promise<Product[]> {
  return (
    await c.query<Product>(
      `SELECT p.*,COALESCE(array_agg(a.normalized_alias) FILTER (WHERE a.alias_id IS NOT NULL),'{}') AS aliases FROM catalog_products p LEFT JOIN product_aliases a USING(product_id) GROUP BY p.product_id ORDER BY p.slug`,
    )
  ).rows;
}
export async function policy(
  c: pg.PoolClient,
  source: string,
): Promise<Policy & { policy_id: string }> {
  const p = (
    await c.query<Policy & { policy_id: string }>(
      `SELECT p.*,s.enabled FROM sources s JOIN source_policies p USING(policy_id) WHERE source_id=$1 FOR SHARE OF s,p`,
      [source],
    )
  ).rows[0];
  if (!p) throw new Error('Unknown source');
  return p;
}
async function event(
  c: pg.PoolClient,
  job: string,
  code: string,
  details: Record<string, unknown> = {},
) {
  await c.query(
    'INSERT INTO job_events(event_id,job_id,code,details) VALUES($1,$2,$3,$4)',
    [randomUUID(), job, code, details],
  );
}
export async function enqueue(db: Database, runKey: string) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(runKey))
    throw new Error('Invalid run idempotency key');
  for (const source of fixtureSources)
    await db.pool.query(
      `INSERT INTO crawl_jobs(job_id,source_id,run_key) VALUES($1,$2,$3) ON CONFLICT(source_id,run_key) DO NOTHING`,
      [stableId(`job:${source}:${runKey}`), source, runKey],
    );
}
interface Job {
  job_id: string;
  source_id: string;
  attempts: number;
}
// Claim leases allow a killed worker to resume; each fixture batch commits atomically with its checkpoint.
export async function processNext(
  db: Database,
  connectorFactory: (s: string) => Connector = fixtureConnector,
): Promise<boolean> {
  const job = await transaction(db, async (c) => {
    const row = (
      await c.query<Job>(
        `SELECT * FROM crawl_jobs WHERE ((state IN ('queued','retry') AND next_retry_at<=now()) OR (state='running' AND lease_until<now())) AND attempts<3 ORDER BY queued_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (!row) return null;
    await c.query(
      `UPDATE crawl_jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '30 seconds',started_at=now() WHERE job_id=$1`,
      [row.job_id],
    );
    await event(c, row.job_id, 'claimed', { attempt: row.attempts + 1 });
    return { ...row, attempts: row.attempts + 1 };
  });
  // Exhausted crashed jobs must not stay running forever.
  if (!job) {
    await db.pool.query(
      `UPDATE crawl_jobs SET state='dead_letter',error_code='lease_exhausted',lease_until=NULL WHERE state='running' AND attempts>=3 AND lease_until<now()`,
    );
    return false;
  }
  try {
    const connector = connectorFactory(job.source_id);
    // Check rights before discovery; check again under lock when committing.
    await transaction(db, async (c) =>
      assertPolicy(await policy(c, job.source_id)),
    );
    const records = await connector.discover();
    if (records.length > 10000) throw new ConnectorError('oversized_fixture');
    await transaction(db, async (c) => {
      const locked = (
        await c.query<{ state: string; attempts: number }>(
          `SELECT state,attempts FROM crawl_jobs WHERE job_id=$1 FOR UPDATE`,
          [job.job_id],
        )
      ).rows[0]!;
      if (locked.state !== 'running' || locked.attempts !== job.attempts)
        throw new Error('Stale worker lease');
      const p = await policy(c, job.source_id);
      assertPolicy(p);
      const products = await catalog(c);
      let inserted = 0,
        duplicates = 0,
        invalid = 0;
      for (const raw of records) {
        let item: SourceItem;
        try {
          item = connector.fetchMetadata(raw);
          canonicalUrl(item.url);
        } catch {
          invalid++;
          await event(c, job.job_id, 'invalid_record');
          continue;
        }
        const url = canonicalUrl(item.url);
        const obs = extract(item, job.source_id, p.policy_id, products);
        const itemId = stableId(`item:${job.source_id}:${item.external_id}`);
        const tomb = (
          await c.query(
            `SELECT 1 FROM tombstones WHERE source_id=$1 OR item_id=$2`,
            [job.source_id, itemId],
          )
        ).rowCount;
        if (tomb) {
          await event(c, job.job_id, 'tombstone_suppressed');
          continue;
        }
        const existing = (
          await c.query<{ item_id: string; content_hash: string }>(
            `SELECT item_id,content_hash FROM source_items WHERE source_id=$1 AND (external_id=$2 OR canonical_url=$3)`,
            [job.source_id, item.external_id, url],
          )
        ).rows[0];
        if (existing) {
          await c.query(
            'UPDATE source_items SET last_seen_at=now() WHERE item_id=$1',
            [existing.item_id],
          );
          if (existing.content_hash !== obs.source_content_hash) {
            await event(c, job.job_id, 'changed_content_requires_review');
            const affected = (
              await c.query<{
                payload: Observation;
                observation_id: string;
                review_status: string;
              }>('SELECT * FROM observations WHERE item_id=$1 FOR UPDATE', [
                existing.item_id,
              ])
            ).rows;
            for (const previous of affected) {
              const next =
                previous.review_status === 'approved_for_analysis'
                  ? 'revoked'
                  : previous.review_status;
              const updated = observation.parse({
                ...previous.payload,
                review_status: next,
                quality_flags: [
                  ...new Set([
                    ...previous.payload.quality_flags,
                    'content_changed',
                  ]),
                ],
                ...(next !== previous.review_status
                  ? {
                      reviewer_id: 'system-worker',
                      reviewed_at: new Date().toISOString(),
                    }
                  : {}),
              });
              await c.query(
                'UPDATE observations SET payload=$2,review_status=$3 WHERE observation_id=$1',
                [previous.observation_id, updated, next],
              );
              if (next !== previous.review_status) {
                const key = randomUUID();
                await c.query(
                  `INSERT INTO review_events(event_id,observation_id,actor_id,prior_status,new_status,reason,idempotency_key,request_hash) VALUES($1,$2,'system-worker',$3,'revoked','correction',$4,$5)`,
                  [
                    randomUUID(),
                    previous.observation_id,
                    previous.review_status,
                    key,
                    hash(key),
                  ],
                );
                await c.query(
                  'UPDATE export_batches SET retraction_required=true WHERE $1::uuid=ANY(observation_ids)',
                  [previous.observation_id],
                );
              }
            }
          }
          duplicates++;
          continue;
        }
        await c.query(
          `INSERT INTO source_items(item_id,source_id,external_id,canonical_url,published_at,content_hash,rights_policy_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            itemId,
            job.source_id,
            item.external_id,
            url,
            item.published_at,
            obs.source_content_hash,
            p.policy_id,
          ],
        );
        // Experience key supplied only by trusted fixture metadata; never link real users cross-site.
        const fingerprint = hash(
          `${obs.independence_group_key}:${obs.product_match.catalog_product_id ?? normalize(item.product_label)}:${item.topic ?? 'unknown'}`,
        );
        const result = await c.query(
          `INSERT INTO observations(observation_id,item_id,product_id,fingerprint,independence_group_key,payload,export_fields) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(fingerprint) DO NOTHING`,
          [
            obs.observation_id,
            itemId,
            obs.product_match.catalog_product_id,
            fingerprint,
            obs.independence_group_key,
            obs,
            {
              would_recommend: item.would_recommend,
              worth_the_price: item.worth_the_price,
            },
          ],
        );
        if (result.rowCount) inserted++;
        else duplicates++;
      }
      await c.query(
        `UPDATE crawl_jobs SET state='completed',lease_until=NULL,error_code=NULL,external_cursor=$2 WHERE job_id=$1`,
        [job.job_id, connector.checkpoint(records.length)],
      );
      await c.query(
        'UPDATE sources SET last_success_at=now() WHERE source_id=$1',
        [job.source_id],
      );
      await event(c, job.job_id, 'completed', {
        records: records.length,
        inserted,
        duplicates,
        invalid,
      });
    });
  } catch (error) {
    const code =
      error instanceof ConnectorError
        ? error.code
        : error instanceof Error && error.message.includes('policy')
          ? 'policy_denied'
          : 'processing_failed';
    await transaction(db, async (c) => {
      // Do not let an expired/stale worker overwrite a newer claim.
      const result = await c.query(
        `UPDATE crawl_jobs SET state=$2,error_code=$3,next_retry_at=now()+($4 * interval '1 second'),lease_until=NULL WHERE job_id=$1 AND state='running' AND attempts=$5 RETURNING job_id`,
        [
          job.job_id,
          job.attempts >= 3 ||
          ['403', 'policy_denied', 'oversized_fixture'].includes(code)
            ? 'dead_letter'
            : 'retry',
          code,
          2 ** job.attempts,
          job.attempts,
        ],
      );
      if (result.rowCount) {
        if (code === '403')
          await c.query('UPDATE sources SET enabled=false WHERE source_id=$1', [
            job.source_id,
          ]);
        await event(c, job.job_id, code, { attempt: job.attempts });
      }
    });
  }
  return true;
}
export async function ingest(db: Database, runKey: string) {
  await enqueue(db, runKey);
  while (await processNext(db)) {
    /* only immediately due jobs */
  }
  return (
    await db.pool.query(
      `SELECT state,count(*)::int AS count FROM crawl_jobs WHERE run_key=$1 GROUP BY state ORDER BY state`,
      [runKey],
    )
  ).rows;
}
