-- Migration: Per-vertical RepID Engine & Gates
-- Created: 2026-06-18
-- Component: Per-Vertical Accuracy Engine
-- Additive companion AFTER INSERT trigger to track accuracy per vertical task domain.

-- 1. Ensure event_type check constraint allows 'x402_value_delivered'
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
  'VALIDATOR_PENALTY'::text, 'SERVICE_FULFILLED'::text, 'SERVICE_SATISFIED'::text, 
  'x402_value_delivered'::text
]));

-- 2. Define vertical accuracy trigger function
CREATE OR REPLACE FUNCTION public.apply_vertical_accuracy()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_domain_accuracy JSONB;
  v_domain_data     JSONB;
  v_count           integer;
  v_pct             numeric;
  v_new_count       integer;
  v_new_pct         numeric;
  v_event_score     numeric;
BEGIN
  -- Only run if task_domain is present and not empty
  IF NEW.task_domain IS NULL OR NEW.task_domain = '' THEN
    RETURN NEW;
  END IF;

  -- Select existing domain_accuracy
  SELECT domain_accuracy INTO v_domain_accuracy
  FROM public.repid_agents WHERE id = NEW.agent_id;

  IF v_domain_accuracy IS NULL THEN
    v_domain_accuracy := '{}'::jsonb;
  END IF;

  v_domain_data := v_domain_accuracy->NEW.task_domain;

  -- Determine event score (100 for positive/zero delta, 0 for negative/veto)
  IF COALESCE(NEW.delta, 0) >= 0 THEN
    v_event_score := 100.0;
  ELSE
    v_event_score := 0.0;
  END IF;

  IF v_domain_data IS NULL THEN
    v_new_count := 1;
    v_new_pct := v_event_score;
  ELSE
    -- Support both 'count'/'total' and 'pct' keys
    v_count := COALESCE(
      (v_domain_data->>'count')::integer,
      (v_domain_data->>'total')::integer,
      0
    );
    v_pct := COALESCE(
      (v_domain_data->>'pct')::numeric,
      0.0
    );

    v_new_count := v_count + 1;
    v_new_pct := ROUND(((v_pct * v_count) + v_event_score) / v_new_count, 1);
  END IF;

  -- Update repid_agents
  UPDATE public.repid_agents
  SET domain_accuracy = jsonb_set(
    COALESCE(domain_accuracy, '{}'::jsonb),
    ARRAY[NEW.task_domain],
    jsonb_build_object('pct', v_new_pct, 'count', v_new_count)
  ),
  last_updated = now()
  WHERE id = NEW.agent_id;

  RETURN NEW;
END;
$function$;

-- 3. Bind vertical accuracy trigger AFTER INSERT
DROP TRIGGER IF EXISTS trg_apply_vertical_accuracy ON public.repid_score_events;
CREATE TRIGGER trg_apply_vertical_accuracy
AFTER INSERT ON public.repid_score_events
FOR EACH ROW
EXECUTE FUNCTION public.apply_vertical_accuracy();

-- 4. get_vertical_repid helper function
CREATE OR REPLACE FUNCTION public.get_vertical_repid(p_agent_id uuid, p_domain text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_domain_accuracy jsonb;
  v_pct             numeric;
BEGIN
  SELECT domain_accuracy INTO v_domain_accuracy
  FROM public.repid_agents WHERE id = p_agent_id;
  
  IF v_domain_accuracy IS NULL THEN
    RETURN 0.0;
  END IF;
  
  v_pct := (v_domain_accuracy->p_domain->>'pct')::numeric;
  RETURN COALESCE(v_pct, 0.0);
END;
$function$;

-- 5. v_repid_by_vertical view
CREATE OR REPLACE VIEW public.v_repid_by_vertical AS
SELECT 
  id AS agent_id,
  agent_name,
  'overall' AS vertical,
  current_repid::numeric AS vertical_score,
  current_repid AS overall_repid,
  tier
FROM public.repid_agents
UNION ALL
SELECT 
  r.id AS agent_id,
  r.agent_name,
  d.key AS vertical,
  (d.value->>'pct')::numeric AS vertical_score,
  r.current_repid AS overall_repid,
  r.tier
FROM public.repid_agents r,
LATERAL jsonb_each(COALESCE(r.domain_accuracy, '{}'::jsonb)) d;

-- 6. can_act_in_vertical gate function
CREATE OR REPLACE FUNCTION public.can_act_in_vertical(p_agent_id uuid, p_domain text, p_min_score numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_vertical_score numeric;
  v_agent_name     text;
  v_agent_type     text;
  v_current_repid  integer;
BEGIN
  -- Get agent info
  SELECT agent_name, agent_type, current_repid INTO v_agent_name, v_agent_type, v_current_repid
  FROM public.repid_agents WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Prevent mock/perceived-only agents from acting in medical/financial
  IF v_agent_name LIKE 'trinity-agent-mock-%' OR v_agent_type = 'perceived' THEN
    RETURN FALSE;
  END IF;

  -- Get vertical score (weighted average accuracy pct)
  v_vertical_score := public.get_vertical_repid(p_agent_id, p_domain);

  -- Gate on the vertical score (accuracy must be >= min_score)
  IF v_vertical_score < p_min_score THEN
    RETURN FALSE;
  END IF;

  -- For medical/financial, also require that they have a minimum earned overall RepID (e.g. ESTABLISHED tier 1000+)
  IF (p_domain = 'medical' OR p_domain = 'finance') AND v_current_repid < 1000 THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$function$;
