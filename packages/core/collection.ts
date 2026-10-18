import { contentIdentity, normalizedContentUrl } from './content-identity.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { transaction, type Database } from '../db/client.js';
import { assertSource, readSource, sourceEvent } from './sources.js';
import { requireActor, type Actor } from './moderation.js';
import { hash, stableId } from './identity.js';
import { catalog } from './pipeline.js';
import { resolveMention } from './intelligence.js';
import { extractExternal, type ExtractionProvider } from './evidence.js';
import { observation, type Observation } from '../contracts/index.js';
import {
  discoverExternal,
  type DiscoveryBatch,
} from '../connectors/external.js';
import {
  CollectionError,
  allowedUrl,
  validateResponse,
  type HttpTransport,
  type HttpRequest,
} from '../connectors/http.js';
export interface CollectionOptions {
  windowId?: string;
  windowCheckpoint?: Record<string, unknown>;
  window?: { start: string; end: string };
  transport: HttpTransport;
  provider?: ExtractionProvider;
  secret?: (name: string) => string | undefined;
  actor: Actor;
  force?: boolean;
}
interface Job {
  job_id: string;
  state: string;
  attempts: number;
  next_retry_at: Date;
}
export async function collectSource(
  db: Database,
  sourceId: string,
  runKey: string,
  options: CollectionOptions,
) {
  requireActor(options.actor, true);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(runKey))
    throw new CollectionError('invalid_request_key');
  const owner = randomUUID();
  let job: Job | undefined;
  let sourcePolicy = '';
  const claimed = await transaction(db, async (c) => {
    const source = await readSource(c, sourceId, true);
    if (source.operational_state === 'suspended')
      throw new CollectionError('source_suspended');
    const jobId = stableId(`collection:${sourceId}:${runKey}`);
    await c.query(
      `INSERT INTO crawl_jobs(job_id,source_id,run_key,request_key) VALUES($1,$2,$3,$4) ON CONFLICT(request_key) DO NOTHING`,
      [jobId, sourceId, runKey, `${sourceId}:${runKey}`],
    );
    job = (
      await c.query<Job>(
        'SELECT * FROM crawl_jobs WHERE job_id=$1 FOR UPDATE',
        [jobId],
      )
    ).rows[0]!;
    if (['completed', 'dead_letter'].includes(job.state)) return false;
    const lease = (
      await c.query<{ busy: boolean }>(
        'SELECT (lease_until>now()) AS busy FROM sources WHERE source_id=$1',
        [sourceId],
      )
    ).rows[0]!;
    if (lease.busy) return false;
    if (job.state === 'retry' && job.next_retry_at > new Date()) return false;
    if (job.attempts >= 3) {
      await c.query(
        `UPDATE crawl_jobs SET state='dead_letter',error_code='lease_exhausted' WHERE job_id=$1`,
        [jobId],
      );
      job.state = 'dead_letter';
      return false;
    }
    if (
      !options.force &&
      job.state !== 'retry' &&
      source.next_collection_at &&
      new Date(source.next_collection_at) > new Date()
    )
      return false;
    // Mock runs also require an explicit operator-approved policy, never just a URL.
    try {
      assertSource(source, options.transport.mode);
    } catch (e) {
      const code = e instanceof CollectionError ? e.code : 'policy_denied';
      await c.query(
        `UPDATE crawl_jobs SET state='dead_letter',error_code=$2 WHERE job_id=$1`,
        [jobId, code],
      );
      await sourceEvent(c, sourceId, options.actor.id, code);
      job.state = 'dead_letter';
      return false;
    }
    if (options.windowId) {
      await c.query(
        `UPDATE sources SET discovery_state=$2,etag=NULL,last_modified=NULL WHERE source_id=$1`,
        [sourceId, options.windowCheckpoint ?? {}],
      );
      await c.query(
        'UPDATE collection_windows SET job_id=$2 WHERE window_id=$1',
        [options.windowId, jobId],
      );
    }
    sourcePolicy = source.policy_id;
    await c.query(
      `UPDATE sources SET lease_owner=$2,lease_until=now()+interval '120 seconds' WHERE source_id=$1`,
      [sourceId, owner],
    );
    await c.query(
      `UPDATE crawl_jobs SET state='running',attempts=attempts+1,started_at=now(),lease_until=now()+interval '120 seconds' WHERE job_id=$1`,
      [jobId],
    );
    job.attempts++;
    job.state = 'running';
    return true;
  });
  if (!claimed)
    return {
      job_id: job!.job_id,
      state: job!.state,
      reused: true,
      requests: 0,
    };
  const jobId = job!.job_id;
  let requests = 0,
    inserted = 0,
    facts = 0;
  const request = async (input: HttpRequest) => {
    // Small configured intervals are paced; larger intervals defer the durable job without losing pages.
    let wait = 0;
    const reserve = async () =>
      transaction(db, async (c) => {
        const source = await readSource(c, sourceId, true);
        assertSource(source, options.transport.mode);
        if (source.policy_id !== sourcePolicy)
          throw new CollectionError('policy_changed');
        allowedUrl(input.url, source.settings.allowed_hosts);
        const state = (
          await c.query<{
            quota_used: number;
            today: boolean;
            last_request_at: Date | null;
            lease_owner: string;
          }>(
            `SELECT quota_used,quota_day=current_date AS today,last_request_at,lease_owner FROM sources WHERE source_id=$1`,
            [sourceId],
          )
        ).rows[0]!;
        if (state.lease_owner !== owner)
          throw new CollectionError('lease_lost');
        const units = input.quotaUnits ?? 1;
        if (!Number.isInteger(units) || units < 1 || units > 100)
          throw new CollectionError('invalid_quota_units');
        if ((state.today ? state.quota_used : 0) + units > source.daily_budget)
          throw new CollectionError('quota_exhausted', 86400);
        const remaining = state.last_request_at
          ? source.min_request_interval_ms -
            (Date.now() - state.last_request_at.getTime())
          : 0;
        if (remaining > 0)
          throw new CollectionError(
            'rate_limited',
            Math.ceil(remaining / 1000),
          );
        const id = randomUUID();
        await c.query(
          `UPDATE sources SET quota_day=current_date,quota_used=CASE WHEN quota_day=current_date THEN quota_used+$2 ELSE $2 END,last_request_at=now(),lease_until=now()+interval '120 seconds' WHERE source_id=$1`,
          [sourceId, units],
        );
        await c.query(
          'INSERT INTO collection_requests(request_id,source_id,quota_units) VALUES($1,$2,$3)',
          [id, sourceId, units],
        );
        return id;
      });
    // Reserve atomically; a short wait is bounded and is revalidated before sending.
    let id: string;
    try {
      id = await reserve();
    } catch (e) {
      if (
        e instanceof CollectionError &&
        e.code === 'rate_limited' &&
        e.retryAfterSeconds === 1
      ) {
        wait = 1000;
        await delay(wait);
        id = await reserve();
      } else throw e;
    }
    requests++;
    try {
      const res = await options.transport.request(input);
      validateResponse(res);
      await db.pool.query(
        'UPDATE collection_requests SET status_code=$2 WHERE request_id=$1',
        [id, res.status],
      );
      return res;
    } catch (e) {
      const code = e instanceof CollectionError ? e.code : 'network_failed';
      await db.pool.query(
        'UPDATE collection_requests SET error_code=$2 WHERE request_id=$1',
        [id, code],
      );
      throw e;
    }
  };
  const persist = async (batch: DiscoveryBatch) => {
    let pageInserted = 0,
      pageFacts = 0;
    const metrics = {
      new_records: 0,
      duplicates_skipped: 0,
      records_updated: 0,
      new_observations: 0,
      valid_player_observations: 0,
      ambiguous_matches: 0,
      awaiting_moderation: 0,
      outside_window: 0,
      undated_records: 0,
    };
    await transaction(db, async (c) => {
      const source = await readSource(c, sourceId, true);
      assertSource(source, options.transport.mode);
      const lease = (
        await c.query<{ lease_owner: string }>(
          'SELECT lease_owner FROM sources WHERE source_id=$1',
          [sourceId],
        )
      ).rows[0]!;
      if (source.policy_id !== sourcePolicy || lease.lease_owner !== owner)
        throw new CollectionError('policy_changed');
      const products = await catalog(c);
      for (const record of batch.records) {
        if (options.window) {
          if (!record.published_at) {
            metrics.undated_records++;
            continue;
          }
          const published = new Date(record.published_at).getTime();
          if (
            published < Date.parse(options.window.start) ||
            published >= Date.parse(options.window.end)
          ) {
            metrics.outside_window++;
            continue;
          }
        }
        if (source.registry && source.registry.category !== 'retailer') {
          const contentType =
            source.type === 'manufacturer'
              ? 'product-facts'
              : source.registry.category === 'editorial'
                ? 'editorial-metadata'
                : source.registry.category === 'youtube'
                  ? 'discovery-metadata'
                  : record.kind === 'player'
                    ? 'firsthand-experience'
                    : 'product-discovery';
          if (!source.registry_review?.approved_content.includes(contentType))
            throw new CollectionError('unapproved_content_type');
        }
        allowedUrl(record.url, source.settings.allowed_hosts, true);
        record.url = normalizedContentUrl(record.url);
        const canonicalLabels = (
          record.product_labels ?? [record.product_label || record.title]
        ).map(
          (label) =>
            resolveMention({ label }, products).catalog_product_id ?? label,
        );
        const identity = contentIdentity(record, sourceId, canonicalLabels);
        if (record.published_at)
          record.published_at = new Date(record.published_at).toISOString();
        let itemId = stableId(
          `external-item:${sourceId}:${record.external_id}`,
        );
        const tomb = (
          await c.query(
            'SELECT 1 FROM tombstones WHERE source_id=$1 OR item_id=$2 OR canonical_url_hash=$3',
            [sourceId, itemId, hash(record.url)],
          )
        ).rowCount;
        if (tomb) continue;
        const incomingExternalId = record.external_id;
        const previous = (
          await c.query<{
            item_id: string;
            external_id: string;
            content_hash: string;
            rights_policy_id: string;
            content_fingerprint: string | null;
            experience_key: string | null;
          }>(
            `SELECT i.* FROM source_items i WHERE i.source_id=$1 AND (i.item_id=$2 OR i.normalized_url=normalized_content_url($3) OR i.content_fingerprint=$4 OR i.experience_key=$5 OR EXISTS(SELECT 1 FROM source_item_keys k WHERE k.source_id=$1 AND k.item_id=i.item_id AND ((k.kind='external' AND k.value=$6) OR (k.kind='url' AND k.value=normalized_content_url($3)) OR (k.kind='content' AND k.value=$4) OR (k.kind='experience' AND k.value=$5)))) ORDER BY i.first_collected_at LIMIT 1 FOR UPDATE`,
            [
              sourceId,
              itemId,
              record.url,
              identity.content,
              identity.experience,
              record.external_id,
            ],
          )
        ).rows[0];
        if (previous) {
          itemId = previous.item_id;
          record.external_id = previous.external_id;
        }
        if (
          (await c.query('SELECT 1 FROM tombstones WHERE item_id=$1', [itemId]))
            .rowCount
        ) {
          metrics.duplicates_skipped++;
          continue;
        }
        const aliasKeys = [
          ['external', incomingExternalId],
          ['url', record.url],
          ['content', identity.content],
          ['experience', identity.experience],
        ];
        // Source locks serialize item upserts; unique indexes remain the final database guard.
        const contentHash = hash(JSON.stringify(record));
        await c.query(
          `INSERT INTO source_items(item_id,source_id,external_id,canonical_url,published_at,content_hash,rights_policy_id) VALUES($1,$2,$3,$4,$5::timestamptz,$6,$7) ON CONFLICT(item_id) DO UPDATE SET last_seen_at=now()`,
          [
            itemId,
            sourceId,
            record.external_id,
            record.url,
            record.published_at,
            contentHash,
            source.policy_id,
          ],
        );
        for (const [kind, value] of aliasKeys)
          if (value)
            await c.query(
              'INSERT INTO source_item_keys(source_id,kind,value,item_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              [sourceId, kind, value, itemId],
            );
        if (
          previous?.content_fingerprint &&
          previous.content_fingerprint === identity.content &&
          previous.rights_policy_id === source.policy_id
        ) {
          metrics.duplicates_skipped++;
          continue;
        }
        if (
          previous?.content_hash === contentHash &&
          previous.rights_policy_id === source.policy_id
        ) {
          metrics.duplicates_skipped++;
          continue;
        }
        if (previous) metrics.records_updated++;
        else metrics.new_records++;
        await c.query(
          'UPDATE source_items SET content_fingerprint=$2,experience_key=COALESCE($3,experience_key) WHERE item_id=$1',
          [itemId, identity.content, identity.experience],
        );
        // A revision suppresses prior reviewed evidence instead of silently changing it in place.
        if (previous) {
          await c.query(
            `UPDATE manufacturer_facts SET review_status='revoked' WHERE item_id=$1`,
            [itemId],
          );
          const old = (
            await c.query<{
              observation_id: string;
              review_status: string;
              payload: Observation;
            }>('SELECT * FROM observations WHERE item_id=$1 FOR UPDATE', [
              itemId,
            ])
          ).rows;
          for (const row of old) {
            if (row.review_status === 'revoked') continue;
            const revised = observation.parse({
              ...row.payload,
              review_status: 'revoked',
              reviewer_id: 'system-collector',
              reviewed_at: new Date().toISOString(),
            });
            await c.query(
              `UPDATE observations SET review_status='revoked',payload=$2 WHERE observation_id=$1`,
              [row.observation_id, revised],
            );
            const key = randomUUID();
            await c.query(
              `INSERT INTO review_events(event_id,observation_id,actor_id,prior_status,new_status,reason,idempotency_key,request_hash) VALUES($1,$2,'system-collector',$3,'revoked','correction',$4,$5)`,
              [
                randomUUID(),
                row.observation_id,
                row.review_status,
                key,
                hash(key),
              ],
            );
            await c.query(
              'UPDATE export_batches SET retraction_required=true WHERE $1::uuid=ANY(observation_ids)',
              [row.observation_id],
            );
          }
          await c.query(
            'UPDATE source_items SET content_hash=$2,rights_policy_id=$3,published_at=$4,canonical_url=$5 WHERE item_id=$1',
            [
              itemId,
              contentHash,
              source.policy_id,
              record.published_at,
              record.url,
            ],
          );
        }
        // Commercial enrichment is retained as source metadata only, never player evidence.
        if (source.registry?.category === 'retailer') continue;
        if (
          source.registry?.category === 'editorial' &&
          record.kind !== 'editorial' &&
          record.kind !== 'discovery'
        )
          throw new CollectionError('unapproved_content_type');
        if (source.type === 'manufacturer') {
          if (!source.allowed_operations.manufacturer_facts)
            throw new CollectionError('policy_denied');
          const match = resolveMention(
            { label: record.product_label || record.title },
            products,
          );
          const factInserted = await c.query(
            `INSERT INTO manufacturer_facts(fact_id,item_id,product_id,policy_id,specifications,model,variant,release_date,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(item_id,policy_id,content_hash) DO NOTHING`,
            [
              stableId(`fact:${itemId}:${source.policy_id}:${contentHash}`),
              itemId,
              match.catalog_product_id,
              source.policy_id,
              record.facts ?? {},
              record.model ?? null,
              record.variant ?? null,
              record.release_date ?? null,
              contentHash,
            ],
          );
          if (factInserted.rowCount) pageFacts++;
        } else {
          if (
            !source.allowed_operations.derived_insights &&
            record.kind !== 'discovery' &&
            record.kind !== 'editorial'
          )
            throw new CollectionError('policy_denied');
          for (const label of record.product_labels ?? [
            record.product_label || record.title,
          ]) {
            const extracted = await extractExternal(
              { ...record, product_label: label },
              source,
              products,
              options.provider,
            );
            const obs = extracted.obs;
            // Content revisions get new stable IDs; unchanged content is not restaged or counted twice.
            const productKey =
              obs.product_match.catalog_product_id ??
              label.normalize('NFKC').toLowerCase().trim();
            const fingerprint = hash(
              `${extracted.fingerprint}:${contentHash}:${productKey}`,
            );
            obs.independence_group_key =
              identity.experience ?? identity.observation;
            obs.observation_id = stableId(
              `external-observation:${fingerprint}`,
            );
            const result = await c.query(
              `INSERT INTO observations(observation_id,item_id,product_id,fingerprint,independence_group_key,payload,export_fields,experience_key,product_key,evidence_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
              [
                obs.observation_id,
                itemId,
                obs.product_match.catalog_product_id,
                fingerprint,
                obs.independence_group_key,
                obs,
                {
                  would_recommend: record.structured.would_recommend ?? null,
                  worth_the_price: record.structured.worth_the_price ?? null,
                },
                identity.observation,
                productKey,
                identity.revision,
              ],
            );
            if (result.rowCount) {
              pageInserted++;
              metrics.new_observations++;
              metrics.awaiting_moderation++;
              if (obs.quality_flags.includes('ambiguous_product'))
                metrics.ambiguous_matches++;
              if (
                obs.observation_kind === 'first_hand_player_experience' &&
                !obs.quality_flags.length
              )
                metrics.valid_player_observations++;
              const e = extracted.evidence;
              await c.query(
                'INSERT INTO observation_evidence(observation_id,attributes,extraction_confidence,experience_basis,provenance) VALUES($1,$2,$3,$4,$5)',
                [
                  obs.observation_id,
                  JSON.stringify(e.attributes),
                  e.extraction_confidence,
                  e.experience_basis,
                  e.provenance,
                ],
              );
            } else metrics.duplicates_skipped++;
          }
        }
      }
      if (options.windowId)
        await c.query(
          'UPDATE collection_windows SET checkpoint=$2 WHERE window_id=$1',
          [options.windowId, batch.state],
        );
      for (const [key, value] of Object.entries(metrics))
        await c.query(
          `UPDATE crawl_jobs SET metrics=jsonb_set(metrics,ARRAY[$2],to_jsonb(COALESCE((metrics->>$2)::int,0)+$3::int)) WHERE job_id=$1`,
          [jobId, key, value],
        );
      await c.query(
        'UPDATE sources SET discovery_state=$2,etag=COALESCE($3,etag),last_modified=COALESCE($4,last_modified) WHERE source_id=$1',
        [sourceId, batch.state, batch.etag ?? null, batch.lastModified ?? null],
      );
    });
    inserted += pageInserted;
    facts += pageFacts;
  };
  try {
    const source = await transaction(db, (c) => readSource(c, sourceId));
    source.collection_window = options.window;
    const discovered = await discoverExternal(
      source,
      request,
      options.secret,
      persist,
    );
    if (
      options.window &&
      (discovered.state.next ||
        discovered.state.page ||
        Number(discovered.state.search ?? 0) > 0)
    )
      throw new CollectionError('pagination_incomplete', 1);
    await transaction(db, async (c) => {
      const current = await readSource(c, sourceId, true);
      assertSource(current, options.transport.mode);
      const result = await c.query(
        `UPDATE sources SET lease_owner=NULL,lease_until=NULL,last_success_at=now(),last_error_code=NULL,next_collection_at=now()+(interval_seconds*interval '1 second') WHERE source_id=$1 AND lease_owner=$2`,
        [sourceId, owner],
      );
      if (!result.rowCount) throw new CollectionError('lease_lost');
      await c.query(
        `UPDATE crawl_jobs SET state='completed',error_code=NULL,lease_until=NULL,external_cursor=$2 WHERE job_id=$1`,
        [jobId, JSON.stringify(current.discovery_state)],
      );
      await sourceEvent(c, sourceId, options.actor.id, 'collection_completed', {
        job_id: jobId,
        requests,
        inserted,
        facts,
      });
    });
    return { job_id: jobId, state: 'completed', requests, inserted, facts };
  } catch (error) {
    const code =
      error instanceof CollectionError ? error.code : 'invalid_response';
    const deferred = [
      'quota_exhausted',
      'rate_limited',
      'pagination_incomplete',
    ].includes(code);
    const terminal =
      [
        '403',
        '401',
        'policy_denied',
        'policy_changed',
        'unapproved_content_type',
        'commercial_permission_required',
        'source_suspended',
        'destination_denied',
        'ssrf_denied',
        'live_collection_disabled',
        'html_requires_separate_parser_approval',
      ].includes(code) ||
      (!deferred && job!.attempts >= 3);
    const seconds = Math.max(
      2 ** job!.attempts,
      error instanceof CollectionError ? (error.retryAfterSeconds ?? 0) : 0,
    );
    await transaction(db, async (c) => {
      const changed = await c.query(
        `UPDATE sources SET lease_owner=NULL,lease_until=NULL,last_error_code=$3,next_collection_at=now()+($4*interval '1 second'),enabled=CASE WHEN $3 IN ('403','401') THEN false ELSE enabled END WHERE source_id=$1 AND lease_owner=$2`,
        [sourceId, owner, code, seconds],
      );
      if (changed.rowCount) {
        await c.query(
          `UPDATE crawl_jobs SET state=$2,error_code=$3,next_retry_at=now()+($4*interval '1 second'),lease_until=NULL,attempts=attempts-$5 WHERE job_id=$1`,
          [
            jobId,
            terminal ? 'dead_letter' : 'retry',
            code,
            seconds,
            deferred ? 1 : 0,
          ],
        );
        await sourceEvent(c, sourceId, options.actor.id, 'collection_failed', {
          job_id: jobId,
          error_code: code,
        });
      }
    });
    return {
      job_id: jobId,
      state: terminal ? 'dead_letter' : 'retry',
      error_code: code,
      requests,
      inserted,
      facts,
    };
  }
}
export async function collectDue(
  db: Database,
  options: CollectionOptions & {
    transportForSource?: (id: string) => Promise<HttpTransport>;
  },
) {
  requireActor(options.actor, true);
  const due = (
    await db.pool.query<{ source_id: string }>(
      `SELECT s.source_id FROM sources s JOIN source_policies p USING(policy_id) WHERE s.enabled=true AND s.operational_state='active' AND p.status='approved' AND p.expires_at>now() AND s.type NOT LIKE 'fixture-%' AND (s.next_collection_at IS NULL OR s.next_collection_at<=now()) ORDER BY CASE s.registry->>'priority' WHEN 'P1' THEN 1 WHEN 'P3' THEN 3 ELSE 2 END,s.next_collection_at NULLS FIRST,s.source_id LIMIT 100`,
    )
  ).rows;
  const results = [];
  for (const s of due) {
    const retry = (
      await db.pool.query<{ run_key: string }>(
        `SELECT run_key FROM crawl_jobs WHERE source_id=$1 AND state IN ('retry','running','queued') ORDER BY queued_at LIMIT 1`,
        [s.source_id],
      )
    ).rows[0];
    results.push(
      await collectSource(db, s.source_id, retry?.run_key ?? randomUUID(), {
        ...options,
        transport: options.transportForSource
          ? await options.transportForSource(s.source_id)
          : options.transport,
      }),
    );
  }
  return results;
}
