CREATE TABLE source_policies (
 policy_id text PRIMARY KEY, status text NOT NULL CHECK(status IN ('approved','revoked','pending')),
 allowed_operations jsonb NOT NULL, permission_reference text NOT NULL, reviewed_by text NOT NULL,
 reviewed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, retention jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1
);
CREATE TABLE sources (
 source_id text PRIMARY KEY, name text NOT NULL, type text NOT NULL CHECK(type IN ('fixture-json','fixture-csv','fixture-rss')),
 enabled boolean NOT NULL DEFAULT false, policy_id text NOT NULL REFERENCES source_policies,
 last_success_at timestamptz
);
CREATE TABLE catalog_products (
 product_id uuid PRIMARY KEY, tpr_product_id uuid, slug text UNIQUE NOT NULL, brand text NOT NULL,
 name text NOT NULL, model_number text UNIQUE NOT NULL, category text NOT NULL, type text NOT NULL,
 catalog_snapshot_version text NOT NULL
);
CREATE TABLE product_aliases (
 alias_id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES catalog_products,
 normalized_alias text NOT NULL, origin text NOT NULL, UNIQUE(product_id,normalized_alias)
);
CREATE TABLE crawl_jobs (
 job_id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources, run_key text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry','completed','dead_letter')),
 attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, queued_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
 error_code text, external_cursor text, UNIQUE(source_id,run_key)
);
CREATE TABLE source_items (
 item_id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources, external_id text NOT NULL,
 canonical_url text NOT NULL, published_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(),
 content_hash text NOT NULL, rights_policy_id text NOT NULL REFERENCES source_policies,
 UNIQUE(source_id,external_id), UNIQUE(source_id,canonical_url)
);
CREATE TABLE observations (
 observation_id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES source_items,
 product_id uuid REFERENCES catalog_products, fingerprint text UNIQUE NOT NULL,
 independence_group_key text NOT NULL, review_status text NOT NULL DEFAULT 'staged'
 CHECK(review_status IN ('staged','approved_for_analysis','rejected','revoked')),
 payload jsonb NOT NULL, export_fields jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_review_idx ON observations(review_status,product_id);
CREATE INDEX observations_item_idx ON observations(item_id);
CREATE TABLE review_events (
 event_id uuid PRIMARY KEY, observation_id uuid NOT NULL REFERENCES observations, actor_id text NOT NULL,
 prior_status text NOT NULL, new_status text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key text UNIQUE NOT NULL, request_hash text NOT NULL
);
CREATE FUNCTION protect_review_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'review_events is append-only'; END $$;
CREATE TRIGGER review_events_immutable BEFORE UPDATE OR DELETE ON review_events FOR EACH ROW EXECUTE FUNCTION protect_review_events();
CREATE TABLE export_batches (
 batch_id uuid PRIMARY KEY, schema_version text NOT NULL, produced_at timestamptz NOT NULL DEFAULT now(),
 count integer NOT NULL, file_sha256 text NOT NULL, manifest jsonb NOT NULL,
 observation_ids uuid[] NOT NULL, approval_state text NOT NULL DEFAULT 'authorized_local',
 retraction_required boolean NOT NULL DEFAULT false
);
CREATE TABLE tombstones (
 tombstone_id uuid PRIMARY KEY, item_id uuid REFERENCES source_items, source_id text REFERENCES sources,
 reason text NOT NULL, actor_id text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
 export_retraction_status text NOT NULL DEFAULT 'local_manifests_marked'
);
CREATE TABLE job_events (
 event_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES crawl_jobs, code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL DEFAULT '{}'
);
