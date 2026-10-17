DO $$ BEGIN IF EXISTS(SELECT 1 FROM sources WHERE type='api') THEN RAISE EXCEPTION 'Preserve or explicitly remove generic API sources before reverting'; END IF; END $$;
ALTER TABLE sources DROP CONSTRAINT sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check CHECK(type IN ('fixture-json','fixture-csv','fixture-rss','youtube','rss','manufacturer','forum','approved-html'));
