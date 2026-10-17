ALTER TABLE sources ADD COLUMN registry jsonb;
ALTER TABLE sources ADD COLUMN operational_state text NOT NULL DEFAULT 'disabled' CHECK (operational_state IN ('disabled','active','suspended'));
UPDATE sources SET operational_state='active' WHERE enabled;
CREATE FUNCTION sync_source_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.enabled THEN NEW.operational_state := 'active';
 ELSIF OLD.enabled THEN NEW.operational_state := 'disabled'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_operation BEFORE INSERT OR UPDATE OF enabled ON sources FOR EACH ROW EXECUTE FUNCTION sync_source_operation();
ALTER TABLE sources ADD CONSTRAINT source_operational_consistency CHECK (enabled = (operational_state='active'));
-- Category distinguishes intentional editorial/community identities on a shared domain.
CREATE UNIQUE INDEX source_registry_identity ON sources ((COALESCE(registry->>'category','custom')), (lower(regexp_replace(url,'/+$','')))) WHERE url IS NOT NULL;
ALTER TABLE source_policies ADD COLUMN registry_review jsonb;
