-- Rollback Migration: Per-vertical RepID Engine & Gates
-- Created: 2026-06-18

DROP FUNCTION IF EXISTS public.can_act_in_vertical(uuid, text, numeric);
DROP VIEW IF EXISTS public.v_repid_by_vertical;
DROP FUNCTION IF EXISTS public.get_vertical_repid(uuid, text);
DROP TRIGGER IF EXISTS trg_apply_vertical_accuracy ON public.repid_score_events;
DROP FUNCTION IF EXISTS public.apply_vertical_accuracy();

-- Restore original repid_score_events_event_type_check check constraint (excluding x402_value_delivered)
ALTER TABLE public.repid_score_events DROP CONSTRAINT IF EXISTS repid_score_events_event_type_check;
ALTER TABLE public.repid_score_events ADD CONSTRAINT repid_score_events_event_type_check 
CHECK (event_type = ANY (ARRAY[
  'CHALLENGE_WIN'::text, 'CHALLENGE_LOSS'::text, 'CHALLENGE_DRAW'::text, 
  'EPISTEMIC_VIOLATION'::text, 'CONSTITUTIONAL_VIOLATION'::text, 'PREDICTION_RESOLVE'::text, 
  'STAKE'::text, 'GENESIS'::text, 'REFERRAL'::text, 'PEACEMAKER'::text, 
  'SELF_MONITOR'::text, 'DECAY'::text, 'DORMANCY_DECAY'::text, 'SALE_DROP'::text, 
  'MIRROR_TEST_MODE7'::text, 'CONSTITUTIONAL_PASS'::text, 'CODE_CONTRIBUTION'::text, 
  'WORKFLOW_CONTRIBUTION'::text, 'TOOL_PIONEER'::text, 'AGENT_TEACHING'::text, 
  'AUDIT_CONTRIBUTION'::text, 'CONSTITUTIONAL_AUDIT'::text, 'MCP_TOOL_CALL'::text, 
  'LATENCY_OPPORTUNITY_LEARNING'::text, 'BOUNTY_CLAIM'::text, 'BOUNTY_COMPLETE'::text, 
  'BOUNTY_VERIFY'::text, 'HAL_SCORE_EVENT'::text, 'PAPER_TRADE_OUTCOME'::text, 
  'VALIDATION_PASSED'::text, 'VALIDATION_FAILED'::text, 'VALIDATOR_REWARD'::text, 
  'VALIDATOR_PENALTY'::text, 'SERVICE_FULFILLED'::text, 'SERVICE_SATISFIED'::text
]));
