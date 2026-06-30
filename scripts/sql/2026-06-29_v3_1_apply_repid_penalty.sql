-- v3.1 ATOMIC PENALTY RPC — audit row + bypass-apply + floor_override + mercy-mutex, in ONE transaction.
-- Branch: feat/cc-2026-06-29-v3.1-audit-atomic-penalty. DRAFT — Sean eyes-on + XC re-verify before prod apply. DO NOT auto-apply.
-- Supersedes the v3 apply_repid_penalty (which applied but wrote no audit row → the audit-atomicity gap CC flagged).
--
-- Why atomic: the existing writers (scoring/pipeline.ts HAL + validation, redteam-adjudication.ts) do
-- INSERT repid_score_events (with repid_delta_applied pre-set so trg_apply_repid_score_event no-ops) + a
-- SEPARATE .update(). The separate update doesn't carry bypass/floor_override, so a sub-floor penalty on a
-- high-peak agent gets re-clamped by trg_repid_earned_floor. This RPC folds insert + apply into one txn: the
-- penalty lands, is audited, sets the persistent floor_override — no double-apply, no re-floor.

-- 3-arg ATOMIC form. Returns the new repid_score_events.id (callers need it for the ZK-proof queue + tool logging).
CREATE OR REPLACE FUNCTION public.apply_repid_penalty(p_agent uuid, p_new_repid integer, p_event jsonb)
 RETURNS bigint
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $f$
DECLARE
  v_cur integer; v_peak integer; v_applied integer; v_delta integer;
  v_event_type text; v_mercy boolean; v_event_id bigint;
BEGIN
  IF p_event IS NULL THEN RAISE EXCEPTION 'apply_repid_penalty(3-arg): p_event required; use the 2-arg form for apply-only'; END IF;

  SELECT current_repid, peak_repid INTO v_cur, v_peak FROM public.repid_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'apply_repid_penalty: agent % not found', p_agent; END IF;

  v_applied := greatest(p_new_repid, 0);                 -- absolute floor 0
  IF v_applied >= v_cur THEN
    RAISE EXCEPTION 'apply_repid_penalty is demotion-only: % must be < current %', v_applied, v_cur;  -- XC guard: no inflation
  END IF;
  v_delta := v_applied - v_cur;                          -- negative

  -- MERCY MUTEX (XC P1-4): a penalty event carries AT MOST ONE mercy. The caller asserts via metadata.mercy_applied
  -- whether THIS event already consumed an intent-grace (§7.1b) carve-out. We stamp mercy_applied ONCE on the row;
  -- the §7.1a recovery-grace consumer (w_volume suspension) MUST read it and skip if already true — so grace
  -- carve-out OR recovery volume-grace, never both on the same event_id.  (NOTE: both consumers are not yet live —
  -- w_volume is unimplemented + §7.1b is BLOCKED-FOR-SHADOW — so this stamps the flag for when they are. See report.)
  v_mercy      := coalesce((p_event->>'mercy_applied')::boolean, false);
  v_event_type := coalesce(p_event->>'event_type', 'PENALTY');

  -- XC v3.1 fix #1 — fail-closed HAL desync guard: a HAL_SCORE_EVENT penalty whose audit row trg_hal_penalty_guard
  -- would zero (no hallucination_caught while config requires it) must NOT silently demote the score (row would say
  -- delta=0 while current_repid dropped). Refuse it so the audit row and the applied score can never diverge.
  IF v_event_type = 'HAL_SCORE_EVENT'
     AND coalesce((p_event->>'hallucination_caught')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'apply_repid_penalty: HAL_SCORE_EVENT penalty without hallucination_caught — refused (would desync audit vs score)';
  END IF;

  -- (a) ATOMIC audit row. repid_delta_applied pre-set => trg_apply_repid_score_event RETURNs early (no re-add).
  --     hallucination_caught carried so trg_hal_penalty_guard does not suppress a caller-validated HAL penalty.
  --     Full original payload preserved under metadata.v31_payload so no audit detail is lost via this path.
  INSERT INTO public.repid_score_events (
    agent_id, event_type, delta, repid_before, repid_after,
    repid_delta_calculated, repid_delta_applied,
    hallucination_caught, hal_score, hal_decision, decision_outcome,
    contract_id, idempotency_key, economic_impact_usdc, alignment_category,
    task_domain, certainty_at_claim, metadata
  ) VALUES (
    p_agent, v_event_type, v_delta, v_cur, v_applied,
    coalesce((p_event->>'repid_delta_calculated')::int, v_delta), v_delta,
    (p_event->>'hallucination_caught')::boolean, (p_event->>'hal_score')::numeric, p_event->>'hal_decision',
    coalesce(p_event->>'decision_outcome', p_event->>'hal_decision'),
    p_event->>'contract_id', p_event->>'idempotency_key', (p_event->>'economic_impact_usdc')::numeric, p_event->>'alignment_category',
    p_event->>'task_domain', (p_event->>'certainty_at_claim')::numeric,
    coalesce(p_event->'metadata','{}'::jsonb)
      || jsonb_build_object('mercy_applied', v_mercy, 'v31_atomic', true, 'v31_payload', p_event)
  ) RETURNING id INTO v_event_id;

  -- (b)+(c) apply with bypass + persistent floor_override on sub-floor demotion (else plain demotion within tier)
  IF v_applied < public.tier_lower_bound(v_peak) THEN
    PERFORM set_config('app.bypass_repid_floor','true', true);   -- SET LOCAL (txn-scoped)
    UPDATE public.repid_agents SET current_repid=v_applied, floor_override=v_applied, last_updated=now() WHERE id=p_agent;
  ELSE
    UPDATE public.repid_agents SET current_repid=v_applied, last_updated=now() WHERE id=p_agent;
  END IF;
  RETURN v_event_id;
END;
$f$;

-- 2-arg APPLY-ONLY form (the v3 shadow-prove signature; for callers that wrote their own audit row). Returns applied repid.
CREATE OR REPLACE FUNCTION public.apply_repid_penalty(p_agent uuid, p_new_repid integer)
 RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $f$
DECLARE v_cur integer; v_peak integer; v_applied integer;
BEGIN
  SELECT current_repid, peak_repid INTO v_cur, v_peak FROM public.repid_agents WHERE id=p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'apply_repid_penalty: agent % not found', p_agent; END IF;
  v_applied := greatest(p_new_repid, 0);
  IF v_applied >= v_cur THEN RAISE EXCEPTION 'apply_repid_penalty is demotion-only: % must be < current %', v_applied, v_cur; END IF;
  IF v_applied < public.tier_lower_bound(v_peak) THEN
    PERFORM set_config('app.bypass_repid_floor','true', true);
    UPDATE public.repid_agents SET current_repid=v_applied, floor_override=v_applied, last_updated=now() WHERE id=p_agent;
  ELSE
    UPDATE public.repid_agents SET current_repid=v_applied, last_updated=now() WHERE id=p_agent;
  END IF;
  RETURN v_applied;
END;
$f$;

-- Hardened grants (both overloads): service_role only.
REVOKE ALL ON FUNCTION public.apply_repid_penalty(uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_repid_penalty(uuid, integer)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_repid_penalty(uuid, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_repid_penalty(uuid, integer)       TO service_role;

-- ROLLBACK: DROP FUNCTION public.apply_repid_penalty(uuid,integer,jsonb);  then restore the v3 2-arg body from
-- CC_CAUSE_AWARE_FLOOR_DDL_v3.md. The v3 trigger + floor_override column are unaffected.
