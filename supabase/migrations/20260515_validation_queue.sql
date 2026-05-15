-- Async validation queue. Phase 2.5 builds the scaffolding;
-- Phase 2.6 wires PCP + adversarial judge into the worker body.

CREATE TABLE IF NOT EXISTS validation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id BIGINT NOT NULL REFERENCES trinity_tasks(id) ON DELETE CASCADE,
  substance_gate_event_id UUID NULL REFERENCES substance_gate_events(id),
  
  status TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  
  fast_path_passed BOOLEAN NOT NULL,
  deep_validation_needed BOOLEAN NOT NULL DEFAULT true,
  
  -- Phase 2.6 will populate these
  pcp_score NUMERIC(4,3) NULL,
  judge_verdict TEXT NULL,
  judge_confidence NUMERIC(4,3) NULL,
  validator_agents TEXT[] NULL,  -- which agents validated
  
  worker_verdict TEXT NULL,  -- final verdict from worker (e.g., 'passed_stub_no_pcp_yet' in 2.5)
  
  metadata JSONB DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL,
  
  CONSTRAINT validation_queue_processed_check 
    CHECK ((status IN ('completed','failed','skipped')) = (processed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS validation_queue_status_idx ON validation_queue(status, created_at);
CREATE INDEX IF NOT EXISTS validation_queue_task_idx ON validation_queue(task_id);

COMMENT ON TABLE validation_queue IS 'Phase 2.5 scaffolding for async deep validation. Worker stub in 2.5 marks all entries as completed immediately. Phase 2.6 adds real PCP + adversarial judge logic.';
