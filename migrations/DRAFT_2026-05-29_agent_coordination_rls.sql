-- ============================================================================
-- DRAFT — FOR SEAN TO APPLY. NOT self-applied [sprint rule]. Validated only in
-- rolled-back transactions against the live DB (zero persistent change).
-- ============================================================================
-- Sprint 2026-05-29 — agent coordination tables (agent_reports RLS + dispatch_queue).
--
-- PHASE-1 FINDING (verified [sql:2026-05-29], corrects the premise):
--   agent_reports has RLS ON + 0 policies. That locks out NON-bypass roles only
--   (anon, authenticated). The agents (CC/GA/XC) write through the repid-engine
--   backend as:
--     • postgres     — via direct-pg / pgQuery (DATABASE_URL pooler, port 6543)
--     • service_role — via supabase-js (SUPABASE_SERVICE_KEY)
--   BOTH have rolbypassrls=true, so the backend can ALREADY write; the table is
--   locked to the PUBLIC, not to the agents. Proven live (rolled back):
--     anon INSERT  → ERROR 42501 (RLS denial)
--     postgres / service_role INSERT → OK
--
--   => RLS is the PUBLIC boundary. It does NOT gate the bypass backend roles.
--      The policies below make the posture EXPLICIT/least-privilege. The
--      dispatch execution gate is therefore ALSO enforced in application logic
--      (claimDispatch WHERE approved_by_sean=true), not relied on at RLS for the
--      bypass roles. See HARDENING note at the bottom.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. agent_reports — explicit least-privilege. service_role (PostgREST path)
--    may read/write; anon + authenticated have NO policy → denied (the current
--    implicit state, now intentional). postgres bypasses RLS by design.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS agent_reports_service_rw ON public.agent_reports;
CREATE POLICY agent_reports_service_rw ON public.agent_reports
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- (No anon/authenticated policy is created → they remain denied under RLS.)

-- ----------------------------------------------------------------------------
-- 2. dispatch_queue — new table. approved_by_sean is the EXECUTION GATE: a
--    dispatch is only claimable/executable once Sean flips it true (defaults
--    false). claimedDispatch() enforces the gate in SQL; the RLS UPDATE policy
--    encodes the same gate for any future non-bypass access path.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id       text NOT NULL,
  dispatch_type   text NOT NULL,                       -- e.g. 'build' | 'review' | 'research'
  target_agent    text,                                -- optional: pin to one agent
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending',     -- pending|claimed|executing|done|failed
  approved_by_sean boolean NOT NULL DEFAULT false,     -- EXECUTION GATE (Sean flips true)
  claimed_by      text,
  claimed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_queue_status_chk
    CHECK (status IN ('pending','claimed','executing','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_queue_claimable
  ON public.dispatch_queue (created_at)
  WHERE status = 'pending' AND approved_by_sean = true;

ALTER TABLE public.dispatch_queue ENABLE ROW LEVEL SECURITY;

-- service_role: read + insert freely; UPDATE (claim/execute) ONLY on approved rows.
DROP POLICY IF EXISTS dispatch_queue_service_select ON public.dispatch_queue;
CREATE POLICY dispatch_queue_service_select ON public.dispatch_queue
  FOR SELECT TO service_role USING (true);

DROP POLICY IF EXISTS dispatch_queue_service_insert ON public.dispatch_queue;
CREATE POLICY dispatch_queue_service_insert ON public.dispatch_queue
  FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS dispatch_queue_service_claim ON public.dispatch_queue;
CREATE POLICY dispatch_queue_service_claim ON public.dispatch_queue
  FOR UPDATE TO service_role
  USING (approved_by_sean = true)        -- can only act on Sean-approved rows
  WITH CHECK (true);

-- (anon + authenticated get NO policy → fully denied under RLS.)

COMMIT;

-- ============================================================================
-- VERIFICATION (run as Sean after apply — all rolled back during the sprint):
--   SET LOCAL ROLE anon; INSERT INTO agent_reports(...);    -- expect 42501
--   RESET ROLE;          INSERT INTO agent_reports(...);    -- expect OK (postgres)
--   -- dispatch claim gate: insert one approved + one unapproved pending row;
--   -- claimDispatch claims only the approved one; the unapproved is never taken.
--
-- OPTIONAL HARDENING (Sean decision — makes RLS the BINDING enforcement for
-- agents instead of just the public boundary): create a dedicated NOBYPASSRLS
-- role (e.g. agent_writer), GRANT it INSERT/SELECT/UPDATE here, and point
-- direct-pg's DATABASE_URL at that role. Then the RLS policies above (incl. the
-- approved_by_sean UPDATE gate) bind the agents too — not just anon. This is a
-- credential/architecture change owned by Sean; not done here.
-- ============================================================================
