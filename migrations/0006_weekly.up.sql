CREATE FUNCTION normalized_content_url(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH base AS (SELECT split_part(split_part(value,'#',1),'?',1) AS url)
 SELECT regexp_replace(regexp_replace(url,'^https://[^/]+','https://'||lower(split_part(url,'/',3))),'/+$','') ||
 COALESCE((SELECT '?' || string_agg(part,'&' ORDER BY part) FROM unnest(string_to_array(split_part(split_part(value,'#',1),'?',2),'&')) part WHERE part<>'' AND part !~* '^(utm_[^=]*|fbclid|gclid)='),'') FROM base
$$;
ALTER TABLE source_items ADD COLUMN normalized_url text GENERATED ALWAYS AS (normalized_content_url(canonical_url)) STORED;
CREATE UNIQUE INDEX source_item_normalized_identity ON source_items(source_id,normalized_url);
ALTER TABLE source_items ADD COLUMN content_fingerprint text;
ALTER TABLE source_items ADD COLUMN experience_key text;
CREATE UNIQUE INDEX source_item_content_identity ON source_items(source_id,content_fingerprint) WHERE content_fingerprint IS NOT NULL;
CREATE UNIQUE INDEX source_item_experience_identity ON source_items(source_id,experience_key) WHERE experience_key IS NOT NULL;
CREATE TABLE source_item_keys (
 source_id text NOT NULL REFERENCES sources, kind text NOT NULL CHECK(kind IN ('external','url','content','experience')),
 value text NOT NULL, item_id uuid NOT NULL REFERENCES source_items ON DELETE CASCADE,
 PRIMARY KEY(source_id,kind,value)
);
INSERT INTO source_item_keys SELECT source_id,'external',external_id,item_id FROM source_items;
INSERT INTO source_item_keys SELECT source_id,'url',normalized_url,item_id FROM source_items;
ALTER TABLE observations ADD COLUMN experience_key text;
ALTER TABLE observations ADD COLUMN product_key text;
ALTER TABLE observations ADD COLUMN evidence_revision text;
CREATE UNIQUE INDEX observation_experience_identity ON observations(experience_key,(COALESCE(product_id::text,product_key)),evidence_revision) WHERE experience_key IS NOT NULL AND review_status<>'revoked';
ALTER TABLE crawl_jobs ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN weekly_covered_until timestamptz;
ALTER TABLE sources ADD COLUMN weekly_last_success_at timestamptz;
CREATE TABLE collection_windows (
 window_id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources,
 kind text NOT NULL CHECK(kind IN ('weekly','backfill')), window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry','completed','failed')),
 attempts integer NOT NULL DEFAULT 0, job_id uuid REFERENCES crawl_jobs, next_retry_at timestamptz NOT NULL DEFAULT now(),
 checkpoint jsonb NOT NULL DEFAULT '{}', last_job_metrics jsonb NOT NULL DEFAULT '{}', metrics jsonb NOT NULL DEFAULT '{}', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK(window_start<window_end), UNIQUE(source_id,kind,window_end)
);
-- A source has only one unfinished window, including the separate backfill path.
CREATE UNIQUE INDEX one_open_collection_window ON collection_windows(source_id) WHERE state IN ('pending','running','retry');
CREATE UNIQUE INDEX one_backfill_per_source ON collection_windows(source_id) WHERE kind='backfill';
CREATE TABLE weekly_reports (
 report_id uuid PRIMARY KEY, slot timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL
);
