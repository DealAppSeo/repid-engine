-- ================================================================
-- CC Sprint 8 — repid_score_events.event_type_check + 'paper_trade_outcome'
-- 2026-05-12
-- ================================================================
-- Sprint 2 (commit 072b0d5) shipped src/services/repid-earning.ts
-- with recordOutcome() inserting event_type='paper_trade_outcome'.
-- The repid_score_events_event_type_check CHECK constraint did not
-- include that value — so every recordOutcome() call has been failing
-- silently with constraint violation since Sprint 2 merged.
--
-- Sprint 8's integration test (tests/integration/repid-earning.test.ts)
-- caught this on first run. Adding 'paper_trade_outcome' to the allowed
-- list closes the gap.
--
-- The 26 prior allowed values are preserved verbatim.
--
-- Rollback: drop and recreate without 'paper_trade_outcome'. Don't roll
-- back unless paper-trade-outcome scoring is intentionally disabled.
-- ================================================================

ALTER TABLE public.repid_score_events
  DROP CONSTRAINT IF EXISTS repid_score_events_event_type_check;

ALTER TABLE public.repid_score_events
  ADD CONSTRAINT repid_score_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'CHALLENGE_WIN'::text, 'CHALLENGE_LOSS'::text, 'CHALLENGE_DRAW'::text,
    'EPISTEMIC_VIOLATION'::text, 'CONSTITUTIONAL_VIOLATION'::text,
    'PREDICTION_RESOLVE'::text, 'STAKE'::text, 'GENESIS'::text,
    'REFERRAL'::text, 'PEACEMAKER'::text, 'SELF_MONITOR'::text,
    'DECAY'::text, 'MIRROR_TEST_MODE7'::text, 'CONSTITUTIONAL_PASS'::text,
    'CODE_CONTRIBUTION'::text, 'WORKFLOW_CONTRIBUTION'::text,
    'TOOL_PIONEER'::text, 'AGENT_TEACHING'::text, 'AUDIT_CONTRIBUTION'::text,
    'CONSTITUTIONAL_AUDIT'::text, 'MCP_TOOL_CALL'::text,
    'LATENCY_OPPORTUNITY_LEARNING'::text, 'BOUNTY_CLAIM'::text,
    'BOUNTY_COMPLETE'::text, 'BOUNTY_VERIFY'::text, 'HAL_SCORE_EVENT'::text,
    'paper_trade_outcome'::text  -- CC Sprint 8: Sprint 2 carry-forward
  ]));
