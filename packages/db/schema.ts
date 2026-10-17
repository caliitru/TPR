import {
  pgTable,
  date,
  doublePrecision,
  unique,
  text,
  uuid,
  boolean,
  integer,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
const time = (name: string) => timestamp(name, { withTimezone: true });
export const sourcePolicies = pgTable('source_policies', {
  policyId: text('policy_id').primaryKey(),
  status: text('status').notNull(),
  allowedOperations: jsonb('allowed_operations').notNull(),
  permissionReference: text('permission_reference').notNull(),
  reviewedBy: text('reviewed_by').notNull(),
  reviewedAt: time('reviewed_at').notNull(),
  expiresAt: time('expires_at').notNull(),
  retention: jsonb('retention').notNull(),
  version: integer('version').notNull().default(1),
  scope: text('scope').notNull().default('mock'),
});
export const sources = pgTable('sources', {
  sourceId: text('source_id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  policyId: text('policy_id')
    .notNull()
    .references(() => sourcePolicies.policyId),
  lastSuccessAt: time('last_success_at'),
  url: text('url'),
  settings: jsonb('settings').notNull().default({}),
  intervalSeconds: integer('interval_seconds').notNull().default(3600),
  lastErrorCode: text('last_error_code'),
  nextCollectionAt: time('next_collection_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  discoveryState: jsonb('discovery_state').notNull().default({}),
  dailyBudget: integer('daily_budget').notNull().default(100),
  minRequestIntervalMs: integer('min_request_interval_ms')
    .notNull()
    .default(1000),
  quotaDay: date('quota_day'),
  quotaUsed: integer('quota_used').notNull().default(0),
  lastRequestAt: time('last_request_at'),
  leaseUntil: time('lease_until'),
  leaseOwner: uuid('lease_owner'),
  liveAuthorized: boolean('live_authorized').notNull().default(false),
});
export const catalogProducts = pgTable(
  'catalog_products',
  {
    productId: uuid('product_id').primaryKey(),
    tprProductId: uuid('tpr_product_id'),
    slug: text('slug').notNull().unique(),
    brand: text('brand').notNull(),
    name: text('name').notNull(),
    modelNumber: text('model_number').notNull(),
    category: text('category').notNull(),
    type: text('type').notNull(),
    catalogSnapshotVersion: text('catalog_snapshot_version').notNull(),
    generation: text('generation'),
    family: text('family'),
    variant: text('variant'),
    configurations: jsonb('configurations').notNull().default({}),
    brandAliases: text('brand_aliases').array().notNull().default([]),
  },
  (table) => [unique().on(table.brand, table.modelNumber)],
);
export const productAliases = pgTable('product_aliases', {
  aliasId: uuid('alias_id').primaryKey(),
  productId: uuid('product_id')
    .notNull()
    .references(() => catalogProducts.productId),
  normalizedAlias: text('normalized_alias').notNull(),
  origin: text('origin').notNull(),
});
export const crawlJobs = pgTable('crawl_jobs', {
  jobId: uuid('job_id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.sourceId),
  runKey: text('run_key').notNull(),
  requestKey: text('request_key').unique(),
  state: text('state').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: time('next_retry_at').notNull().defaultNow(),
  leaseUntil: time('lease_until'),
  queuedAt: time('queued_at').notNull().defaultNow(),
  startedAt: time('started_at'),
  errorCode: text('error_code'),
  externalCursor: text('external_cursor'),
});
export const sourceItems = pgTable('source_items', {
  itemId: uuid('item_id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.sourceId),
  externalId: text('external_id').notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  publishedAt: time('published_at'),
  firstCollectedAt: time('first_collected_at').notNull().defaultNow(),
  purgedAt: time('purged_at'),
  lastSeenAt: time('last_seen_at').notNull().defaultNow(),
  contentHash: text('content_hash').notNull(),
  rightsPolicyId: text('rights_policy_id')
    .notNull()
    .references(() => sourcePolicies.policyId),
});
export const observations = pgTable('observations', {
  observationId: uuid('observation_id').primaryKey(),
  itemId: uuid('item_id')
    .notNull()
    .references(() => sourceItems.itemId),
  productId: uuid('product_id').references(() => catalogProducts.productId),
  fingerprint: text('fingerprint').notNull().unique(),
  independenceGroupKey: text('independence_group_key').notNull(),
  reviewStatus: text('review_status').notNull().default('staged'),
  payload: jsonb('payload').notNull(),
  exportFields: jsonb('export_fields').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const reviewEvents = pgTable('review_events', {
  eventId: uuid('event_id').primaryKey(),
  observationId: uuid('observation_id')
    .notNull()
    .references(() => observations.observationId),
  actorId: text('actor_id').notNull(),
  priorStatus: text('prior_status').notNull(),
  newStatus: text('new_status').notNull(),
  reason: text('reason').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
});
export const exportBatches = pgTable('export_batches', {
  batchId: uuid('batch_id').primaryKey(),
  schemaVersion: text('schema_version').notNull(),
  producedAt: time('produced_at').notNull().defaultNow(),
  count: integer('count').notNull(),
  fileSha256: text('file_sha256').notNull(),
  manifest: jsonb('manifest').notNull(),
  observationIds: uuid('observation_ids').array().notNull(),
  approvalState: text('approval_state').notNull().default('authorized_local'),
  retractionRequired: boolean('retraction_required').notNull().default(false),
});
export const tombstones = pgTable('tombstones', {
  tombstoneId: uuid('tombstone_id').primaryKey(),
  itemId: uuid('item_id').references(() => sourceItems.itemId),
  sourceId: text('source_id').references(() => sources.sourceId),
  reason: text('reason').notNull(),
  canonicalUrlHash: text('canonical_url_hash'),
  actorId: text('actor_id').notNull(),
  appliedAt: time('applied_at').notNull().defaultNow(),
  exportRetractionStatus: text('export_retraction_status')
    .notNull()
    .default('local_manifests_marked'),
});
export const jobEvents = pgTable('job_events', {
  eventId: uuid('event_id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => crawlJobs.jobId),
  code: text('code').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  details: jsonb('details').notNull().default({}),
});

export const sourceEvents = pgTable('source_events', {
  eventId: uuid('event_id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.sourceId),
  actorId: text('actor_id').notNull(),
  code: text('code').notNull(),
  details: jsonb('details').notNull().default({}),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const collectionRequests = pgTable('collection_requests', {
  requestId: uuid('request_id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.sourceId),
  requestedAt: time('requested_at').notNull().defaultNow(),
  quotaUnits: integer('quota_units').notNull(),
  statusCode: integer('status_code'),
  errorCode: text('error_code'),
});
export const manufacturerFacts = pgTable(
  'manufacturer_facts',
  {
    factId: uuid('fact_id').primaryKey(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => sourceItems.itemId),
    productId: uuid('product_id').references(() => catalogProducts.productId),
    policyId: text('policy_id')
      .notNull()
      .references(() => sourcePolicies.policyId),
    specifications: jsonb('specifications').notNull(),
    contentHash: text('content_hash').notNull().default('legacy'),
    model: text('model'),
    variant: text('variant'),
    releaseDate: date('release_date'),
    reviewStatus: text('review_status').notNull().default('staged'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.itemId, t.policyId, t.contentHash)],
);
export const observationEvidence = pgTable('observation_evidence', {
  observationId: uuid('observation_id')
    .primaryKey()
    .references(() => observations.observationId),
  attributes: jsonb('attributes').notNull(),
  extractionConfidence: doublePrecision('extraction_confidence').notNull(),
  experienceBasis: text('experience_basis').notNull(),
  provenance: jsonb('provenance').notNull(),
});
