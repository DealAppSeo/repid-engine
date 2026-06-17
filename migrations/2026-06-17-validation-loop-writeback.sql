-- VALIDATION LOOP BILATERAL WRITEBACK — migrations
-- feat/cc-2026-06-17-validation-loop
-- STAGED for Sean co-sign. Do NOT apply until XC red-team + CC gate passed.
-- Apply with Supabase SQL editor (service role) or MCP execute_sql.
--
-- Changes:
--   1. Partial unique index on repid_score_events.idempotency_key for peer-verify keys (D-WT)
--   2. peer_verify_collusion_cap_exceeded() helper (D-3)
--   3. peer_verify_reward_multiplier() helper (D-5)
--   4. peer_verify_claim_has_anchor() helper (D-1)
-- All objects are CREATE OR REPLACE / IF NOT EXISTS — fully idempotent.

-- ─────────────────────────────────────────────────────────────────────────────
-- D-WT: Partial unique index — one score_event per pvq id per agent per role
-- Blocks double-apply at the DB layer even if code races.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS repid_score_events_idempotency_peer_verify_uq
  ON public.repid_score_events (idempotency_key)
  WHERE idempotency_key LIKE 'peer_verify:%';

-- ─────────────────────────────────────────────────────────────────────────────
-- D-3: Collusion cap — returns true when mutual verified pair exceeds cap in 7d
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.peer_verify_collusion_cap_exceeded(
  p_verifier uuid,
  p_source   uuid,
  p_window   interval DEFAULT interval '7 days',
  p_max_mutual_verified int DEFAULT 25
) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT count(*)
    FROM peer_verification_queue
    WHERE verification_status = 'verified'
      AND completed_at > now() - p_window
      AND (
        (source_agent_id = p_source AND verifier_agent_id = p_verifier)
        OR (source_agent_id = p_verifier AND verifier_agent_id = p_source)
      )
  ), 0) >= p_max_mutual_verified;
$$;

COMMENT ON FUNCTION public.peer_verify_collusion_cap_exceeded IS
  'D-3 defense: returns true when verifier+source pair exceeds p_max_mutual_verified '
  'mutual verifications in the rolling p_window. Call before emitting VALIDATOR_REWARD.';

-- ─────────────────────────────────────────────────────────────────────────────
-- D-5: Diminishing returns — 1/sqrt(N verified/disputed in last 24h) for verifier
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.peer_verify_reward_multiplier(
  p_verifier uuid,
  p_window   interval DEFAULT interval '24 hours'
) RETURNS numeric(6,4)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (1.0 / sqrt(GREATEST(1, count(*))))::numeric(6,4)
  FROM peer_verification_queue
  WHERE verifier_agent_id = p_verifier
    AND verification_status IN ('verified', 'disputed')
    AND completed_at > now() - p_window;
$$;

COMMENT ON FUNCTION public.peer_verify_reward_multiplier IS
  'D-5 defense: Goodhart brake. Returns 1/sqrt(N) where N = verifications by this '
  'agent in the last p_window. Apply: delta := round(base_delta * multiplier).';

-- ─────────────────────────────────────────────────────────────────────────────
-- D-1: Anchor-gated reward — check if source_response_id maps to a HAL anchor
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.peer_verify_claim_has_anchor(
  p_source_response_id text
) RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hal_test_cases h
    WHERE h.id::text = p_source_response_id
  );
  -- Extend with hal_canary_cases once that table is confirmed in schema
$$;

COMMENT ON FUNCTION public.peer_verify_claim_has_anchor IS
  'D-1 defense: returns true when the claim maps to a hal_test_cases anchor. '
  'Full-tier VALIDATOR_REWARD only when this returns true AND anchor audit agrees.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only checks to run after apply)
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'repid_score_events'
--   AND indexname = 'repid_score_events_idempotency_peer_verify_uq';
-- Expected: 1 row.
--
-- SELECT peer_verify_collusion_cap_exceeded(
--   'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'::uuid,
--   'aaaaaaaa-bbbb-4ccc-8ddd-000000000002'::uuid
-- );
-- Expected: false (no history with random UUIDs).
--
-- SELECT peer_verify_reward_multiplier(
--   'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'::uuid
-- );
-- Expected: 1.0000 (no history with random UUID → count=0 → GREATEST(1,0)=1 → 1/sqrt(1)=1).
