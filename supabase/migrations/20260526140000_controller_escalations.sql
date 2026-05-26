-- Controller escalation taxonomy (CC2 2026-05-26). Additive, idempotent.
-- Records the escalation ladder; CC/Gemini/Sean levels also write autonomous_tasks.
-- RLS service_role-only (escalations reference agent/task internals).

CREATE TABLE IF NOT EXISTS controller_escalations (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id BIGINT,                          -- trinity_tasks.id (nullable; not all escalations are task-bound)
  level TEXT NOT NULL CHECK (level IN ('agent_internal','squad_internal','cross_squad','code_agent','sean')),
  summary TEXT NOT NULL,
  detail TEXT,
  routed_to TEXT,                          -- squad | cross_squad | cc | gemini | sean
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','routed','resolved')),
  autonomous_task_id BIGINT REFERENCES autonomous_tasks(id),
  telegram_sent BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_controller_escalations_status ON controller_escalations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controller_escalations_agent ON controller_escalations(agent_id);

ALTER TABLE controller_escalations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='controller_escalations' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON controller_escalations FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
