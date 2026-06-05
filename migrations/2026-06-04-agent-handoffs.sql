-- Phase 2: structured handoff record as canonical inter-agent format.
-- Replaces prose "→ XC" etc. Exact columns: from_agent, to_agent, artifact_path, claim, status (open|accepted|co_signed|closed|bounced), co_signer, created_at, resolved_at.
-- Enumerated before: trinity_mcp_handoffs (has handoff_reason, trust_score, task_id), peer_verification_queue (for verified peer/co-sign claims, referenced in peer-verification routes + RLS lockdown).
-- Chose to stage dedicated agent_handoffs for the exact canonical shape (additive, no schema break).
-- RLS: service-role-only (a), like the 33-set credential tables. No client read/anon policy (internal coordination only).
-- Sean co-signs the apply.

CREATE TABLE IF NOT EXISTS public.agent_handoffs (
  id BIGSERIAL PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  claim TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','accepted','co_signed','closed','bounced')),
  co_signer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- RLS service-role-only (a)
ALTER TABLE IF EXISTS public.agent_handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_handoffs;
CREATE POLICY "service_role_all" ON public.agent_handoffs FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.agent_handoffs IS 'Phase 2 canonical structured inter-agent handoff (from/to, artifact, claim, status, co_signer). (a) service-role-only; classify like 33-set. No anon/client policy.';

-- Sample record (this sprint's ->CC EAS coverage handoff, to prove the shape)
-- Recorded as example; real insert via service_role when CC fires EAS (or manually post-apply).
INSERT INTO public.agent_handoffs (from_agent, to_agent, artifact_path, claim, status, co_signer, created_at) VALUES
('XC', 'CC', 'EAS backfill coverage for zkp-anchor crosscheck (Phase 1/6 of 2026-06-04 dogfood digest sprint)', 'Report eas_anchored >0 + payload-match verified UIDs + coverage # for CC Phase 4 zkp crosscheck', 'open', NULL, NOW())
ON CONFLICT DO NOTHING;

-- Rollback (for Sean): DROP TABLE IF EXISTS public.agent_handoffs; (or disable RLS + drop policy if keeping table)
-- Post-apply verify: SELECT * FROM agent_handoffs LIMIT 1; (service ok, anon denied)