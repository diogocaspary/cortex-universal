-- Cortex Universal production storage baseline.
-- Run with psql: psql -v embedding_dimensions=1536 -f storage/postgres/001_init.sql
\if :{?embedding_dimensions}
\else
  \set embedding_dimensions 1536
\endif
\if :{?cortex_runtime_role}
\else
  \set cortex_runtime_role cortex_runtime
\endif

BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS cortex;
REVOKE ALL ON SCHEMA cortex FROM PUBLIC;

CREATE TABLE IF NOT EXISTS cortex.documents (
  document_pk bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  source_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  media_type text NOT NULL,
  content_reference text NOT NULL,
  idempotency_key text NOT NULL,
  provenance jsonb NOT NULL,
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extensions) = 'object'),
  source_verification jsonb NOT NULL CHECK (jsonb_typeof(source_verification) = 'object'),
  text_content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', text_content)) STORED,
  embedding vector(:embedding_dimensions),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  contradicts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contradicts) = 'array'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  UNIQUE (tenant_id, brain_id, id),
  UNIQUE (tenant_id, brain_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS documents_scope
  ON cortex.documents (tenant_id, brain_id, classification, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_fts
  ON cortex.documents USING gin (search_vector);
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw
  ON cortex.documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS cortex.document_entities (
  document_pk bigint NOT NULL REFERENCES cortex.documents(document_pk) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  entity_id text NOT NULL,
  label text,
  module text,
  PRIMARY KEY (document_pk, entity_id)
);
CREATE INDEX IF NOT EXISTS document_entities_lookup
  ON cortex.document_entities (tenant_id, brain_id, entity_id, module);

CREATE TABLE IF NOT EXISTS cortex.semantic_relations (
  document_pk bigint NOT NULL REFERENCES cortex.documents(document_pk) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  subject text NOT NULL,
  predicate text NOT NULL,
  object text NOT NULL,
  PRIMARY KEY (document_pk, subject, predicate, object)
);

CREATE TABLE IF NOT EXISTS cortex.brain_activity (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  subject_id text NOT NULL,
  summary text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  trace_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  operation text NOT NULL,
  details_hash text NOT NULL,
  policy_fingerprint text,
  previous_hash text,
  event_hash text NOT NULL,
  integrity_method text NOT NULL CHECK (integrity_method IN ('sha256-chain','hmac-sha256-chain'))
);
CREATE INDEX IF NOT EXISTS brain_activity_scope
  ON cortex.brain_activity (tenant_id, brain_id, sequence DESC);

CREATE TABLE IF NOT EXISTS cortex.agent_sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  session_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_scope
  ON cortex.agent_sessions (tenant_id, brain_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS cortex.workforce_records (
  id text NOT NULL,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  record_type text NOT NULL CHECK (record_type IN ('goal','work_item','routine','heartbeat','evaluation')),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, brain_id, id)
);
CREATE INDEX IF NOT EXISTS workforce_records_scope
  ON cortex.workforce_records (tenant_id, brain_id, record_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS cortex.workforce_cost_events (
  id text NOT NULL,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  agent_id text NOT NULL,
  goal_id text NOT NULL,
  work_item_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
  cost_microusd bigint NOT NULL CHECK (cost_microusd >= 0),
  measurement_status text NOT NULL CHECK (measurement_status IN ('provider-reported','subscription-allocated')),
  evidence_reference text NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  PRIMARY KEY (tenant_id, brain_id, id),
  UNIQUE (tenant_id, brain_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workforce_cost_scope
  ON cortex.workforce_cost_events
  (tenant_id, brain_id, agent_id, goal_id, work_item_id, occurred_at);

CREATE TABLE IF NOT EXISTS cortex.guard_proposals (
  proposal_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  session_id text NOT NULL,
  action_key text NOT NULL,
  idempotency_key text,
  decision_json jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX IF NOT EXISTS guard_proposals_session
  ON cortex.guard_proposals (tenant_id, brain_id, session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS guard_proposals_idempotency
  ON cortex.guard_proposals (tenant_id, brain_id, session_id, action_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS cortex.effect_executions (
  proposal_id text PRIMARY KEY REFERENCES cortex.guard_proposals(proposal_id),
  tenant_id text NOT NULL,
  brain_id text NOT NULL,
  decision_id text NOT NULL UNIQUE,
  outcome_json jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz
);

CREATE OR REPLACE FUNCTION cortex.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cortex.% is append-only', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS brain_activity_no_update ON cortex.brain_activity;
CREATE TRIGGER brain_activity_no_update
  BEFORE UPDATE ON cortex.brain_activity
  FOR EACH ROW EXECUTE FUNCTION cortex.reject_audit_mutation();
DROP TRIGGER IF EXISTS brain_activity_no_delete ON cortex.brain_activity;
CREATE TRIGGER brain_activity_no_delete
  BEFORE DELETE ON cortex.brain_activity
  FOR EACH ROW EXECUTE FUNCTION cortex.reject_audit_mutation();
DROP TRIGGER IF EXISTS workforce_cost_no_update ON cortex.workforce_cost_events;
CREATE TRIGGER workforce_cost_no_update
  BEFORE UPDATE ON cortex.workforce_cost_events
  FOR EACH ROW EXECUTE FUNCTION cortex.reject_audit_mutation();
DROP TRIGGER IF EXISTS workforce_cost_no_delete ON cortex.workforce_cost_events;
CREATE TRIGGER workforce_cost_no_delete
  BEFORE DELETE ON cortex.workforce_cost_events
  FOR EACH ROW EXECUTE FUNCTION cortex.reject_audit_mutation();

ALTER TABLE cortex.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.document_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.document_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.semantic_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.semantic_relations FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.brain_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.brain_activity FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.agent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.workforce_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.workforce_records FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.workforce_cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.workforce_cost_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.guard_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.guard_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE cortex.effect_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.effect_executions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_scope_policy ON cortex.documents;
CREATE POLICY documents_scope_policy ON cortex.documents
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
    AND classification = ANY (
      string_to_array(current_setting('app.allowed_classifications', true), ',')
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
    AND classification = ANY (
      string_to_array(current_setting('app.allowed_classifications', true), ',')
    )
  );
DROP POLICY IF EXISTS document_entities_scope_policy ON cortex.document_entities;
CREATE POLICY document_entities_scope_policy ON cortex.document_entities
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS semantic_relations_scope_policy ON cortex.semantic_relations;
CREATE POLICY semantic_relations_scope_policy ON cortex.semantic_relations
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS brain_activity_scope_policy ON cortex.brain_activity;
CREATE POLICY brain_activity_scope_policy ON cortex.brain_activity
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS agent_sessions_scope_policy ON cortex.agent_sessions;
CREATE POLICY agent_sessions_scope_policy ON cortex.agent_sessions
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS workforce_records_scope_policy ON cortex.workforce_records;
CREATE POLICY workforce_records_scope_policy ON cortex.workforce_records
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS workforce_cost_scope_policy ON cortex.workforce_cost_events;
CREATE POLICY workforce_cost_scope_policy ON cortex.workforce_cost_events
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS guard_proposals_scope_policy ON cortex.guard_proposals;
CREATE POLICY guard_proposals_scope_policy ON cortex.guard_proposals
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );
DROP POLICY IF EXISTS effect_executions_scope_policy ON cortex.effect_executions;
CREATE POLICY effect_executions_scope_policy ON cortex.effect_executions
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND brain_id = current_setting('app.brain_id', true)
  );

GRANT USAGE ON SCHEMA cortex TO :"cortex_runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cortex TO :"cortex_runtime_role";
GRANT SELECT, INSERT ON
  cortex.documents,
  cortex.document_entities,
  cortex.semantic_relations,
  cortex.brain_activity,
  cortex.workforce_cost_events
TO :"cortex_runtime_role";
GRANT SELECT, INSERT, UPDATE ON
  cortex.agent_sessions,
  cortex.workforce_records,
  cortex.guard_proposals,
  cortex.effect_executions
TO :"cortex_runtime_role";
REVOKE DELETE ON ALL TABLES IN SCHEMA cortex FROM :"cortex_runtime_role";
COMMIT;
