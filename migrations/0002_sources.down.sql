DO $$ BEGIN IF EXISTS(SELECT 1 FROM sources WHERE type NOT LIKE 'fixture-%') THEN RAISE EXCEPTION 'Remove non-fixture sources explicitly before reverting Phase 2'; END IF; END $$;
DROP TABLE observation_evidence,manufacturer_facts,collection_requests,source_events;
ALTER TABLE crawl_jobs DROP COLUMN request_key;
ALTER TABLE catalog_products DROP COLUMN generation,DROP COLUMN family,DROP COLUMN variant,DROP COLUMN configurations,DROP COLUMN brand_aliases;
ALTER TABLE sources DROP CONSTRAINT sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check CHECK(type IN ('fixture-json','fixture-csv','fixture-rss'));
ALTER TABLE source_policies DROP COLUMN scope;
ALTER TABLE sources DROP COLUMN url,DROP COLUMN settings,DROP COLUMN interval_seconds,DROP COLUMN last_error_code,DROP COLUMN next_collection_at,DROP COLUMN etag,DROP COLUMN last_modified,DROP COLUMN discovery_state,DROP COLUMN daily_budget,DROP COLUMN min_request_interval_ms,DROP COLUMN quota_day,DROP COLUMN quota_used,DROP COLUMN last_request_at,DROP COLUMN lease_until,DROP COLUMN lease_owner,DROP COLUMN live_authorized;

ALTER TABLE source_items DROP COLUMN first_collected_at,DROP COLUMN purged_at;
ALTER TABLE source_items ALTER COLUMN published_at SET NOT NULL;
ALTER TABLE tombstones DROP COLUMN canonical_url_hash;
ALTER TABLE catalog_products DROP CONSTRAINT catalog_products_brand_model_number_key;
ALTER TABLE catalog_products ADD UNIQUE(model_number);
