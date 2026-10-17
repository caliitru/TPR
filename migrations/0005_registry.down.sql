ALTER TABLE source_policies DROP COLUMN registry_review;
DROP INDEX source_registry_identity;
DROP TRIGGER source_operation ON sources;
DROP FUNCTION sync_source_operation();
ALTER TABLE sources DROP CONSTRAINT source_operational_consistency;
ALTER TABLE sources DROP COLUMN operational_state;
ALTER TABLE sources DROP COLUMN registry;
