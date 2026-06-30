-- ============================================================================
-- v3.1.1 punch-list — FIXED (CL verification 2026-06-30). DO NOT APPLY — Sean eyes-on + XC re-verify.
-- Supersedes scripts/sql/2026-06-30_v3_1_1_punchlist_DRAFT.sql on feat/cc-2026-06-29-v3.1-audit-atomic-penalty.
--
-- WHAT CHANGED vs the DRAFT (all ground-truth verified against live schema qnnpjhlxljtqyigedwkb):
--   FIX 1 [XC BLOCK — confirmed]: tier_used is TEXT in live schema, draft cast (p_event->>'tier_used')::int
--         → throws on any non-numeric tier ("tier1_only", tier names). Now inserted as text.
--   FIX 2 [XC BLOCK — confirmed]: the draft DROPPED the base RPC's fail-closed NULL-key guard. Restored:
--         a penalty with no idempotency_key is refused (defense-in-depth; ON CONFLICT alone can't dedup NULLs).
--   FIX 3 [CL found]: contract_id + zk_proof_id + llm_call_id are all UUID; inserted from possibly-'' text →
--         empty string throws "invalid input syntax for uuid". Guarded with nullif(...,'')::uuid. (NULL is fine.)
--         NOTE: the base RPC 2026-06-29 shares the latent contract_id risk if applied standalone — guard it there
--         too, or rely on this punch-list (which supersedes the body) being applied right after.
-- UNCHANGED & VERIFIED OK: ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL matches the live
--   partial unique index uq_score_events_idempotency_key [V]; demotion-only + HAL-desync guards intact;
--   tier_lower_bound(peak) exists live, returns integer [V]; all 3 penalty callers bind non-null keys [V].
-- ============================================================================

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

  -- FIX 2 — restore the base-RPC fail-closed NULL-key guard the draft dropped (defense-in-depth).
  IF v_idem IS NULL OR v_idem = '' THEN
    RAISE EXCEPTION 'apply_repid_penalty: idempotency_key required (NULL bypasses dedup -> double-penalty on retry)';
  END IF;

  IF v_event_type = 'HAL_SCORE_EVENT' AND coalesce((p_event->>'hallucination_caught')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'apply_repid_penalty: HAL_SCORE_EVENT penalty without hallucination_caught — refused (audit/score desync)';
  END IF;

  INSERT INTO public.repid_score_events (
    agent_id, event_type, delta, repid_before, repid_after,
    repid_delta_calculated, repid_delta_applied,
    hallucination_caught, hal_score, hal_decision, decision_outcome,
    contract_id, idempotency_key, economic_impact_usdc, alignment_category,
    task_domain, certainty_at_claim,
    llm_provider, llm_model, llm_call_id, prompt_text, answer_text,
    tier_used, zk_proof_triggered, zk_proof_id,
    metadata
  ) VALUES (
    p_agent, v_event_type, v_delta, v_cur, v_applied,
    coalesce((p_event->>'repid_delta_calculated')::int, v_delta), v_delta,
    (p_event->>'hallucination_caught')::boolean, (p_event->>'hal_score')::numeric, p_event->>'hal_decision',
    coalesce(p_event->>'decision_outcome', p_event->>'hal_decision'),
    nullif(p_event->>'contract_id','')::uuid, v_idem, (p_event->>'economic_impact_usdc')::numeric, p_event->>'alignment_category',  -- FIX 3 (extended): contract_id is uuid, guard empty
    p_event->>'task_domain', (p_event->>'certainty_at_claim')::numeric,
    p_event->>'llm_provider', p_event->>'llm_model', nullif(p_event->>'llm_call_id','')::uuid, p_event->>'prompt_text', p_event->>'answer_text',
    p_event->>'tier_used',                                   -- FIX 1: text, not ::int
    (p_event->>'zk_proof_triggered')::boolean, nullif(p_event->>'zk_proof_id','')::uuid,  -- FIX 3: guard empty uuid
    coalesce(p_event->'metadata','{}'::jsonb) || jsonb_build_object('mercy_applied', v_mercy, 'v31_atomic', true)
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
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
-- ROLLBACK: re-CREATE OR REPLACE the v3.1 base body from 2026-06-29_v3_1_apply_repid_penalty.sql.
