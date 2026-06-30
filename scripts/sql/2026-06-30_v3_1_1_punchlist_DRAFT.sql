-- ============================================================================
-- DRAFT — v3.1.1 punch-list (XC fixes #2 audit-columns + #3 idempotency). DO NOT APPLY — Sean eyes-on.
-- Refines the 3-arg apply_repid_penalty(uuid,int,jsonb) from 2026-06-29_v3_1_apply_repid_penalty.sql.
-- Apply AFTER the v3.1 RPC. Reversible (re-CREATE OR REPLACE the v3.1 body to revert).
-- ============================================================================
-- FINDING: a unique index on idempotency_key ALREADY EXISTS:
--   uq_score_events_idempotency_key  UNIQUE (idempotency_key) WHERE idempotency_key IS NOT NULL
-- So #3 needs NO new index — just ON CONFLICT on that partial index + skip-apply when it conflicts (so a
-- retried penalty does not double-apply the score). And its existence proves there are no dup non-null keys.

CREATE OR REPLACE FUNCTION public.apply_repid_penalty(p_agent uuid, p_new_repid integer, p_event jsonb)
 RETURNS bigint
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $f$
DECLARE
  v_cur integer; v_peak integer; v_applied integer; v_delta integer;
  v_event_type text; v_mercy boolean; v_event_id bigint; v_idem text;
BEGIN
  IF p_event IS NULL THEN RAISE EXCEPTION 'apply_repid_penalty(3-arg): p_event required'; END IF;
  SELECT current_repid, peak_repid INTO v_cur, v_peak FROM public.repid_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'apply_repid_penalty: agent % not found', p_agent; END IF;
  v_applied := greatest(p_new_repid, 0);
  IF v_applied >= v_cur THEN RAISE EXCEPTION 'apply_repid_penalty is demotion-only: % must be < current %', v_applied, v_cur; END IF;
  v_delta := v_applied - v_cur;
  v_mercy := coalesce((p_event->>'mercy_applied')::boolean, false);
  v_event_type := coalesce(p_event->>'event_type', 'PENALTY');
  v_idem := p_event->>'idempotency_key';

  IF v_event_type = 'HAL_SCORE_EVENT' AND coalesce((p_event->>'hallucination_caught')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'apply_repid_penalty: HAL_SCORE_EVENT penalty without hallucination_caught — refused (audit/score desync)';
  END IF;

  -- #3 IDEMPOTENCY: if this idempotency_key already landed, DO NOTHING + skip the apply (no double-penalty on retry).
  -- Only meaningful for non-null keys (the partial unique index). Null-key callers are unchanged (no dedup).
  -- #2 AUDIT COLUMNS: map the HAL/validation top-level fields to their columns (not just metadata.v31_payload).
  INSERT INTO public.repid_score_events (
    agent_id, event_type, delta, repid_before, repid_after,
    repid_delta_calculated, repid_delta_applied,
    hallucination_caught, hal_score, hal_decision, decision_outcome,
    contract_id, idempotency_key, economic_impact_usdc, alignment_category,
    task_domain, certainty_at_claim,
    llm_provider, llm_model, llm_call_id, prompt_text, answer_text,   -- #2 added
    tier_used, zk_proof_triggered, zk_proof_id,                        -- #2 added
    metadata
  ) VALUES (
    p_agent, v_event_type, v_delta, v_cur, v_applied,
    coalesce((p_event->>'repid_delta_calculated')::int, v_delta), v_delta,
    (p_event->>'hallucination_caught')::boolean, (p_event->>'hal_score')::numeric, p_event->>'hal_decision',
    coalesce(p_event->>'decision_outcome', p_event->>'hal_decision'),
    p_event->>'contract_id', v_idem, (p_event->>'economic_impact_usdc')::numeric, p_event->>'alignment_category',
    p_event->>'task_domain', (p_event->>'certainty_at_claim')::numeric,
    p_event->>'llm_provider', p_event->>'llm_model', (p_event->>'llm_call_id')::uuid, p_event->>'prompt_text', p_event->>'answer_text',
    (p_event->>'tier_used')::int, (p_event->>'zk_proof_triggered')::boolean, p_event->>'zk_proof_id',
    coalesce(p_event->'metadata','{}'::jsonb) || jsonb_build_object('mercy_applied', v_mercy, 'v31_atomic', true)
    -- NOTE: dropped the duplicate full-payload blob (metadata.v31_payload) now that columns are mapped (#2 / XC bloat note).
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    -- conflict (duplicate idempotency_key) → event already recorded+applied earlier; return existing id, DO NOT re-apply.
    SELECT id INTO v_event_id FROM public.repid_score_events WHERE idempotency_key = v_idem ORDER BY id LIMIT 1;
    RETURN v_event_id;
  END IF;

  IF v_applied < public.tier_lower_bound(v_peak) THEN
    PERFORM set_config('app.bypass_repid_floor','true', true);
    UPDATE public.repid_agents SET current_repid=v_applied, floor_override=v_applied, last_updated=now() WHERE id=p_agent;
  ELSE
    UPDATE public.repid_agents SET current_repid=v_applied, last_updated=now() WHERE id=p_agent;
  END IF;
  RETURN v_event_id;
END;
$f$;
-- (#2 caveat: confirm llm_call_id is uuid + tier_used is int in live schema before apply; cast accordingly. XC re-verify.)
-- #4 mercy note: metadata.mercy_applied is WRITE-ONLY until §7.1a (w_volume) + §7.1b consumers ship — no runtime enforcement yet.
