ALTER TABLE sources DROP CONSTRAINT sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check CHECK(type IN ('fixture-json','fixture-csv','fixture-rss','youtube','rss','manufacturer','forum','approved-html','api'));
