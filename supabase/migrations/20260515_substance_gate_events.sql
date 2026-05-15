-- Substance Gate event log. Every Fast Path execution writes here.
-- This is the audit trail for gate decisions; ties to existing hal_audit_chain
-- and existing repid_score_events.

CREATE TABLE IF NOT EXISTS substance_gate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id BIGINT NOT NULL REFERENCES trinity_tasks(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  
  -- Result text characteristics
  char_count INTEGER NOT NULL,
  result_excerpt TEXT NOT NULL,  -- first 500 chars for audit
  content_hash TEXT NOT NULL,
  
  -- Signal-by-signal results
  signal_char_passed BOOLEAN NOT NULL,
  signal_wrapper_passed BOOLEAN NOT NULL,
  signal_artifact_passed BOOLEAN NOT NULL,
  signal_noop_passed BOOLEAN NOT NULL,
  
  -- Composite outcome
  passed BOOLEAN NOT NULL,
  failure_reasons TEXT[] NULL,  -- array of failed signal names if !passed
  composite_score NUMERIC(4,3) NULL,  -- 0.0-1.0 weighted score
  
  -- Context
  task_tier TEXT NULL,  -- copied from task.metadata.test_tier for fast querying
  reap_count INTEGER DEFAULT 0,  -- copied from task.metadata.reap_count
  
  -- For Phase 2.6 hooks (NULL in 2.5)
  pcp_score NUMERIC(4,3) NULL,
  judge_verdict TEXT NULL,
  judge_confidence NUMERIC(4,3) NULL,
  
  -- Provenance per Framework v1.0
  metadata JSONB DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS substance_gate_events_task_idx ON substance_gate_events(task_id);
CREATE INDEX IF NOT EXISTS substance_gate_events_agent_idx ON substance_gate_events(agent_name);
CREATE INDEX IF NOT EXISTS substance_gate_events_passed_idx ON substance_gate_events(passed, created_at DESC);
CREATE INDEX IF NOT EXISTS substance_gate_events_tier_idx ON substance_gate_events(task_tier);

COMMENT ON TABLE substance_gate_events IS 'Phase 2.5 Substance Gate audit trail. Every Fast Path execution writes a row. Phase 2.6 will populate pcp_score and judge_verdict columns.';
