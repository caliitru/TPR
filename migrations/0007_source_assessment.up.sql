CREATE TABLE source_assessment_runs (
 assessment_id uuid PRIMARY KEY, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL,
 CHECK(jsonb_typeof(report->'sources')='array')
);
CREATE TRIGGER source_assessment_immutable BEFORE UPDATE OR DELETE ON source_assessment_runs FOR EACH ROW EXECUTE FUNCTION protect_review_events();
