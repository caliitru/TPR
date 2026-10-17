ALTER TABLE sources DROP CONSTRAINT sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check CHECK(type IN ('fixture-json','fixture-csv','fixture-rss','youtube','rss','manufacturer','forum','approved-html'));
ALTER TABLE source_policies ADD COLUMN scope text NOT NULL DEFAULT 'mock' CHECK(scope IN ('mock','live'));
ALTER TABLE sources ADD COLUMN url text;
ALTER TABLE sources ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN interval_seconds integer NOT NULL DEFAULT 3600 CHECK(interval_seconds>=60);
ALTER TABLE sources ADD COLUMN last_error_code text;
ALTER TABLE sources ADD COLUMN next_collection_at timestamptz;
ALTER TABLE sources ADD COLUMN etag text;
ALTER TABLE sources ADD COLUMN last_modified text;
ALTER TABLE sources ADD COLUMN discovery_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN daily_budget integer NOT NULL DEFAULT 100 CHECK(daily_budget BETWEEN 1 AND 10000);
ALTER TABLE sources ADD COLUMN min_request_interval_ms integer NOT NULL DEFAULT 1000 CHECK(min_request_interval_ms>=0);
ALTER TABLE sources ADD COLUMN quota_day date;
ALTER TABLE sources ADD COLUMN quota_used integer NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_request_at timestamptz;
ALTER TABLE sources ADD COLUMN lease_until timestamptz;
ALTER TABLE sources ADD COLUMN lease_owner uuid;
ALTER TABLE sources ADD COLUMN live_authorized boolean NOT NULL DEFAULT false CHECK(live_authorized=false);
ALTER TABLE crawl_jobs ADD COLUMN request_key text UNIQUE;
CREATE TABLE source_events (
 event_id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES sources,actor_id text NOT NULL,
 code text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER source_events_immutable BEFORE UPDATE OR DELETE ON source_events FOR EACH ROW EXECUTE FUNCTION protect_review_events();
CREATE TABLE collection_requests (
 request_id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES sources,
 requested_at timestamptz NOT NULL DEFAULT now(),quota_units integer NOT NULL,status_code integer,error_code text
);
CREATE TABLE manufacturer_facts (
 fact_id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES source_items,product_id uuid REFERENCES catalog_products,
 policy_id text NOT NULL REFERENCES source_policies,specifications jsonb NOT NULL,model text,variant text,
 release_date date,review_status text NOT NULL DEFAULT 'staged' CHECK(review_status IN ('staged','rejected','approved_for_analysis','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(item_id,policy_id)
);
CREATE TABLE observation_evidence (
 observation_id uuid PRIMARY KEY REFERENCES observations,attributes jsonb NOT NULL,
 extraction_confidence double precision NOT NULL CHECK(extraction_confidence BETWEEN 0 AND 1),
 experience_basis text NOT NULL,provenance jsonb NOT NULL
);
ALTER TABLE catalog_products ADD COLUMN generation text;
ALTER TABLE catalog_products ADD COLUMN family text;
ALTER TABLE catalog_products ADD COLUMN variant text;
ALTER TABLE catalog_products ADD COLUMN configurations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE catalog_products ADD COLUMN brand_aliases text[] NOT NULL DEFAULT '{}';
CREATE INDEX sources_schedule_idx ON sources(enabled,next_collection_at);
CREATE INDEX source_events_time_idx ON source_events(source_id,created_at DESC);
CREATE INDEX collection_requests_source_idx ON collection_requests(source_id,requested_at DESC);

ALTER TABLE source_items ALTER COLUMN published_at DROP NOT NULL;
ALTER TABLE source_items ADD COLUMN first_collected_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE source_items ADD COLUMN purged_at timestamptz;
ALTER TABLE tombstones ADD COLUMN canonical_url_hash text;
ALTER TABLE catalog_products DROP CONSTRAINT catalog_products_model_number_key;
ALTER TABLE catalog_products ADD UNIQUE(brand,model_number);
