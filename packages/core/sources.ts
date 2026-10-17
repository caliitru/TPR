import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  sourceDefinition,
  policyApproval,
  type RegistrySource,
} from '../contracts/sources.js';
import { transaction, type Database } from '../db/client.js';
import { requireActor, suppress, type Actor } from './moderation.js';
import { allowedUrl, CollectionError } from '../connectors/http.js';
export async function sourceEvent(
  c: pg.PoolClient,
  id: string,
  actor: string,
  code: string,
  details: Record<string, unknown> = {},
) {
  await c.query(
    'INSERT INTO source_events(event_id,source_id,actor_id,code,details) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), id, actor, code, details],
  );
}
export async function readSource(
  c: pg.PoolClient,
  id: string,
  lock = false,
): Promise<RegistrySource> {
  const source = (
    await c.query<RegistrySource>(
      `SELECT s.*,p.status,p.expires_at,p.allowed_operations,p.retention,p.scope,p.registry_review FROM sources s JOIN source_policies p USING(policy_id) WHERE source_id=$1 ${lock ? 'FOR UPDATE OF s FOR SHARE OF p' : ''}`,
      [id],
    )
  ).rows[0];
  if (!source || !source.url) throw new CollectionError('source_not_found');
  return source;
}
export function assertSource(source: RegistrySource, mode: 'mock' | 'live') {
  if (
    !source.enabled ||
    source.status !== 'approved' ||
    new Date(source.expires_at) <= new Date()
  )
    throw new CollectionError('policy_denied');
  if (source.scope !== mode || mode === 'live')
    throw new CollectionError('live_collection_disabled');
  if (
    !source.allowed_operations.discovery ||
    !source.allowed_operations.metadata
  )
    throw new CollectionError('policy_denied');
  if (
    source.type === 'manufacturer' &&
    !source.allowed_operations.manufacturer_facts
  )
    throw new CollectionError('policy_denied');
  if (
    source.registry &&
    (source.registry.commercial_use !== 'approved' || !source.registry_review)
  )
    throw new CollectionError('commercial_permission_required');
  if (source.registry && source.operational_state === 'suspended')
    throw new CollectionError('source_suspended');
  allowedUrl(source.url, source.settings.allowed_hosts);
}
export async function registerSource(
  db: Database,
  input: unknown,
  actor: Actor,
  replace = false,
) {
  requireActor(actor, true);
  const def = sourceDefinition.parse(input);
  allowedUrl(def.url, def.settings.allowed_hosts);
  if (
    def.type === 'youtube' &&
    (!def.settings.allowed_hosts.includes('www.youtube.com') ||
      new URL(def.url).origin !== 'https://www.googleapis.com' ||
      new URL(def.url).pathname !== '/youtube/v3/search')
  )
    throw new CollectionError('youtube_endpoint_denied');
  if (
    def.settings.api_key_env &&
    (def.type !== 'youtube' ||
      def.settings.api_key_env !== 'TPR_YOUTUBE_API_KEY')
  )
    throw new CollectionError('credential_binding_denied');
  return transaction(db, async (c) => {
    const current = (
      await c.query(
        'SELECT source_id,enabled FROM sources WHERE source_id=$1 FOR UPDATE',
        [def.source_id],
      )
    ).rows[0] as { enabled: boolean } | undefined;
    if (current && (!replace || current.enabled))
      throw new CollectionError('disable_before_reconfiguring');
    if (replace && !current) throw new CollectionError('source_not_found');
    const policy = randomUUID();
    await c.query(
      `INSERT INTO source_policies(policy_id,status,allowed_operations,permission_reference,reviewed_by,reviewed_at,expires_at,retention,scope) VALUES($1,'pending','{}','not reviewed',$2,now(),now(),$3,'mock')`,
      [policy, actor.id, { raw_text_hours: 0, metadata_days: 30 }],
    );
    if (current)
      await c.query(
        `UPDATE sources SET name=$2,type=$3,url=$4,settings=$5,interval_seconds=$6,daily_budget=$7,min_request_interval_ms=$8,policy_id=$9,enabled=false,operational_state='disabled',etag=NULL,last_modified=NULL,discovery_state='{}',next_collection_at=NULL WHERE source_id=$1`,
        [
          def.source_id,
          def.name,
          def.type,
          def.url,
          def.settings,
          def.interval_seconds,
          def.daily_budget,
          def.min_request_interval_ms,
          policy,
        ],
      );
    else
      await c.query(
        `INSERT INTO sources(source_id,name,type,url,settings,interval_seconds,daily_budget,min_request_interval_ms,policy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          def.source_id,
          def.name,
          def.type,
          def.url,
          def.settings,
          def.interval_seconds,
          def.daily_budget,
          def.min_request_interval_ms,
          policy,
        ],
      );
    await c.query('UPDATE sources SET registry=$2 WHERE source_id=$1', [
      def.source_id,
      def.registry ?? null,
    ]);
    await sourceEvent(
      c,
      def.source_id,
      actor.id,
      current ? 'source_reconfigured' : 'source_registered',
      { configuration: def },
    );
    return readSource(c, def.source_id);
  });
}
export async function approveSourcePolicy(
  db: Database,
  id: string,
  input: unknown,
  actor: Actor,
) {
  requireActor(actor, true);
  const approval = policyApproval.parse(input);
  if (
    new Date(approval.expires_at) <= new Date() ||
    new Date(approval.expires_at).getTime() > Date.now() + 366 * 86400000
  )
    throw new CollectionError('invalid_policy_expiry');
  if (approval.operations.analyze_body && !approval.operations.derived_insights)
    throw new CollectionError('invalid_policy_operations');
  return transaction(db, async (c) => {
    const current = await readSource(c, id, true);
    if (current.registry) {
      const review = approval.registry_review;
      if (!review || current.registry.commercial_use !== 'approved')
        throw new CollectionError('commercial_permission_required');
      if (
        !current.registry.collection_methods.includes(review.method) ||
        review.approved_content.some(
          (t) => !current.registry!.content_types.includes(t),
        )
      )
        throw new CollectionError('unapproved_collection_scope');
      const expectedMethod =
        current.type === 'rss' ||
        (current.type === 'manufacturer' && current.settings.format !== 'json')
          ? 'official-feed'
          : 'official-api';
      if (review.method !== expectedMethod)
        throw new CollectionError('collection_method_not_implemented');
      if (
        (current.registry.category === 'manufacturer' &&
          current.type !== 'manufacturer') ||
        (current.registry.category === 'youtube' &&
          current.type !== 'youtube') ||
        (current.registry.category === 'retailer' && current.type !== 'api')
      )
        throw new CollectionError('registry_connector_mismatch');
      if (
        current.registry.category === 'retailer' &&
        (approval.operations.derived_insights ||
          approval.operations.analyze_body ||
          approval.operations.manufacturer_facts)
      )
        throw new CollectionError('retailer_evidence_prohibited');
      if (
        current.registry.category === 'manufacturer' &&
        (approval.operations.derived_insights ||
          approval.operations.analyze_body)
      )
        throw new CollectionError('manufacturer_player_evidence_prohibited');
    }
    const policy = randomUUID();
    const v = (
      await c.query<{ version: number }>(
        'SELECT COALESCE(max(version),0)+1 AS version FROM source_policies',
      )
    ).rows[0]!.version;
    await c.query(
      `INSERT INTO source_policies(policy_id,status,allowed_operations,permission_reference,reviewed_by,reviewed_at,expires_at,retention,version,scope) VALUES($1,'approved',$2,$3,$4,now(),$5,$6,$7,'mock')`,
      [
        policy,
        approval.operations,
        approval.permission_reference,
        actor.id,
        approval.expires_at,
        { raw_text_hours: 0, metadata_days: approval.metadata_days },
        v,
      ],
    );
    await c.query(
      'UPDATE source_policies SET registry_review=$2 WHERE policy_id=$1',
      [policy, approval.registry_review ?? null],
    );
    await c.query(
      `UPDATE sources SET policy_id=$2,enabled=false,operational_state='disabled',discovery_state='{}',etag=NULL,last_modified=NULL WHERE source_id=$1`,
      [id, policy],
    );
    await c.query(
      `UPDATE export_batches SET retraction_required=true WHERE EXISTS(SELECT 1 FROM observations o JOIN source_items i USING(item_id) WHERE i.source_id=$1 AND o.observation_id=ANY(export_batches.observation_ids))`,
      [id],
    );
    await sourceEvent(c, id, actor.id, 'policy_approved_mock', {
      policy_id: policy,
      registry_review: approval.registry_review ?? null,
    });
    return readSource(c, id);
  });
}
export async function enableMockSource(db: Database, id: string, actor: Actor) {
  requireActor(actor, true);
  return transaction(db, async (c) => {
    const source = await readSource(c, id, true);
    if (
      (await c.query('SELECT 1 FROM tombstones WHERE source_id=$1', [id]))
        .rowCount
    )
      throw new CollectionError('source_permanently_revoked');
    if (source.operational_state === 'suspended')
      throw new CollectionError('source_suspended');
    assertSource({ ...source, enabled: true }, 'mock');
    await c.query(
      'UPDATE sources SET enabled=true,next_collection_at=now() WHERE source_id=$1',
      [id],
    );
    await sourceEvent(c, id, actor.id, 'mock_source_enabled');
    return { enabled: true, live_enabled: false };
  });
}
export async function suspendSource(db: Database, id: string, actor: Actor) {
  requireActor(actor, true);
  const result = await suppress(
    db,
    { source_id: id },
    'source_suspended',
    actor,
    false,
  );
  await transaction(db, async (c) => {
    await c.query(
      `UPDATE manufacturer_facts SET review_status='revoked' WHERE item_id IN (SELECT item_id FROM source_items WHERE source_id=$1)`,
      [id],
    );
    await c.query(
      "UPDATE sources SET operational_state='suspended' WHERE source_id=$1",
      [id],
    );
    await sourceEvent(c, id, actor.id, 'source_suspended');
  });
  return result;
}
export const sourceFilters = z.strictObject({
  q: z.string().max(120).optional(),
  type: sourceDefinition.shape.type.optional(),
  priority: z.enum(['P1', 'P2', 'P3']).optional(),
  approval: z.enum(['pending', 'approved', 'revoked']).optional(),
  operational: z.enum(['disabled', 'active', 'suspended']).optional(),
});
export async function sourceHealth(db: Database, input: unknown = {}) {
  const f = sourceFilters.parse(input);
  return (
    await db.pool.query(
      `SELECT s.source_id,s.name,s.type,s.url,s.registry,s.operational_state,s.enabled,s.live_authorized,s.interval_seconds,s.last_success_at,s.last_error_code,s.next_collection_at,s.daily_budget,s.quota_used,s.min_request_interval_ms,s.policy_id,p.status,p.scope,p.registry_review,p.reviewed_by,p.reviewed_at,p.version,p.allowed_operations,p.retention,p.permission_reference,p.expires_at,(p.expires_at<=now()) AS policy_expired, CASE WHEN s.last_error_code IS NOT NULL THEN 'error' WHEN s.last_success_at IS NOT NULL THEN 'healthy' ELSE 'never-collected' END AS health, CASE WHEN s.enabled AND p.status='approved' AND p.expires_at>now() THEN 'Actively Collecting (mock only)' WHEN p.status='approved' AND p.expires_at>now() THEN 'Approved (mock only)' ELSE 'Configured' END AS configuration_status FROM sources s JOIN source_policies p USING(policy_id) WHERE ($1::text IS NULL OR s.name ILIKE '%'||$1||'%' OR s.source_id ILIKE '%'||$1||'%' OR s.registry->>'domain' ILIKE '%'||$1||'%') AND ($2::text IS NULL OR s.type=$2) AND ($3::text IS NULL OR s.registry->>'priority'=$3) AND ($4::text IS NULL OR p.status=$4) AND ($5::text IS NULL OR s.operational_state=$5) ORDER BY s.source_id`,
      [
        f.q ?? null,
        f.type ?? null,
        f.priority ?? null,
        f.approval ?? null,
        f.operational ?? null,
      ],
    )
  ).rows;
}
