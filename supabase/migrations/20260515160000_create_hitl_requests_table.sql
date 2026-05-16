ALTER TABLE trinity_tasks DROP CONSTRAINT IF EXISTS valid_task_status;
ALTER TABLE trinity_tasks ADD CONSTRAINT valid_task_status
  CHECK (status IN (
    'pending', 'in_progress', 'doing', 'completed', 'done', 'failed',
    'cancelled', 'archived', 'verified', 'pending_validation', 
    'shadow_reject', 'pending_clarification'
  ));

CREATE TABLE hitl_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id BIGINT NOT NULL REFERENCES trinity_tasks(id),
  validation_queue_id UUID NULL REFERENCES validation_queue(id),
  request_reason TEXT NOT NULL
    CHECK (request_reason IN (
      'judge_escalated',
      'pcp_low_confidence',
      'judge_pcp_disagreement',
      'manual_review',
      'timeout_escalation'
    )),
  request_context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'reviewing', 'resolved', 'expired', 'cancelled')),
  priority INT NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  assigned_to TEXT NULL,
  resolution TEXT NULL
    CHECK (resolution IS NULL OR resolution IN (
      'approve_claimer',
      'challenge_claimer',
      'rework_required',
      'no_action'
    )),
  resolution_notes TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_hitl_requests_status_priority
  ON hitl_requests(status, priority DESC, created_at ASC)
  WHERE status IN ('pending', 'assigned', 'reviewing');

CREATE INDEX idx_hitl_requests_task ON hitl_requests(task_id);

CREATE INDEX idx_hitl_requests_expires
  ON hitl_requests(expires_at)
  WHERE status NOT IN ('resolved', 'cancelled', 'expired');

-- Partial unique index enforces idempotency: one open HITL per (task, validation_queue, reason)
CREATE UNIQUE INDEX uq_hitl_requests_open
  ON hitl_requests(task_id, validation_queue_id, request_reason)
  WHERE status IN ('pending', 'assigned', 'reviewing');

-- Trigger: when resolved, sync verdict back to validation_queue
CREATE OR REPLACE FUNCTION sync_hitl_resolution_to_validation_queue()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'resolved'
     AND OLD.status IS DISTINCT FROM 'resolved'
     AND NEW.validation_queue_id IS NOT NULL THEN
    UPDATE validation_queue
    SET worker_verdict = CASE
          WHEN NEW.resolution = 'approve_claimer'   THEN 'verified'
          WHEN NEW.resolution = 'challenge_claimer' THEN 'challenged'
          WHEN NEW.resolution = 'rework_required'   THEN 'rework'
          ELSE 'human_no_action'
        END,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'hitl_resolved', true,
          'hitl_request_id', NEW.id,
          'hitl_resolution', NEW.resolution,
          'hitl_resolver', NEW.assigned_to,
          'hitl_resolved_at', NEW.resolved_at
        )
    WHERE id = NEW.validation_queue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_hitl_resolution
  AFTER UPDATE ON hitl_requests
  FOR EACH ROW EXECUTE FUNCTION sync_hitl_resolution_to_validation_queue();
