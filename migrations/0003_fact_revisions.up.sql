ALTER TABLE manufacturer_facts DROP CONSTRAINT manufacturer_facts_item_id_policy_id_key;
ALTER TABLE manufacturer_facts ADD COLUMN content_hash text NOT NULL DEFAULT 'legacy';
ALTER TABLE manufacturer_facts ADD UNIQUE(item_id,policy_id,content_hash);
