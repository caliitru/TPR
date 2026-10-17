DO $$ BEGIN IF EXISTS(SELECT 1 FROM manufacturer_facts GROUP BY item_id,policy_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Preserve or explicitly remove fact revisions before reverting'; END IF; END $$;
ALTER TABLE manufacturer_facts DROP CONSTRAINT manufacturer_facts_item_id_policy_id_content_hash_key;
ALTER TABLE manufacturer_facts DROP COLUMN content_hash;
ALTER TABLE manufacturer_facts ADD UNIQUE(item_id,policy_id);
