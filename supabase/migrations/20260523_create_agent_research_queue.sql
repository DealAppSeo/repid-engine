-- Trinity Symphony research task queue (multi-track strategic research dispatch).
-- Internal-only: no API surface. Idempotent (IF NOT EXISTS). Applied 2026-05-23.
CREATE TABLE IF NOT EXISTS agent_research_queue (
  id BIGSERIAL PRIMARY KEY,
  task_uid TEXT UNIQUE NOT NULL,                -- deterministic ID for idempotent reseed
  track_number SMALLINT NOT NULL,               -- 1-6 (the 6 tracks)
  track_name TEXT NOT NULL,                     -- hal_benchmark | red_team_2 | erc_8257 | trust_market | flywheel | integration_matrix
  task_type TEXT NOT NULL,                      -- research | verify | antagonist | synthesis
  assigned_agent_name TEXT NOT NULL,
  assigned_agent_id UUID,
  paired_with_task_uid TEXT,                    -- cross-validation pair
  task_prompt TEXT NOT NULL,
  expected_output_format TEXT NOT NULL,         -- markdown | json | structured_findings
  output_file_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | claimed | in_progress | complete | failed
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  output_summary TEXT,
  cross_validation_verdict TEXT,                -- agree | partial_agree | disagree
  llm_provider_used TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arq_status ON agent_research_queue(status);
CREATE INDEX IF NOT EXISTS idx_arq_track ON agent_research_queue(track_number);
CREATE INDEX IF NOT EXISTS idx_arq_agent ON agent_research_queue(assigned_agent_id);

COMMENT ON TABLE agent_research_queue IS 'Trinity Symphony research task queue for multi-agent strategic research. Internal-only.';
