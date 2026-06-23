-- Migration: Make apply_repid_score_event trigger function NULL-safe on agent_repid_history insert
-- Created: 2026-06-18

CREATE OR REPLACE FUNCTION public.apply_repid_score_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_delta       integer;
  v_before      integer;
  v_after       integer;
  v_agent_text  text;
BEGIN
  -- idempotency: only apply once
  IF NEW.repid_delta_applied IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- CONFIRM #1: canonical delta column. Using repid_delta_calculated, fallback to delta.
  v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
  IF v_delta = 0 THEN
    RETURN NEW;  -- nothing to apply
  END IF;

  -- lock + read current score (agent_id is uuid -> repid_agents.id)
  SELECT current_repid INTO v_before
  FROM repid_agents WHERE id = NEW.agent_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE NOTICE 'apply_repid_score_event: no agent for uuid %', NEW.agent_id;
    RETURN NEW;  -- never silently corrupt; just don't apply
  END IF;

  -- apply to overall score (+ a dimension). CONFIRM #2: dimension mapping per event_type.
  UPDATE repid_agents
     SET current_repid    = COALESCE(v_before,0) + v_delta,
         competence_score = COALESCE(competence_score,0)
                            + (CASE WHEN NEW.event_type LIKE 'x402%' THEN v_delta ELSE 0 END),
         last_updated     = now()
   WHERE id = NEW.agent_id
   RETURNING current_repid, agent_id INTO v_after, v_agent_text;

  -- stamp the event row (BEFORE INSERT, so we just set NEW.*)
  NEW.repid_before        := v_before;
  NEW.repid_after         := v_after;
  NEW.repid_delta_applied := v_delta;

  -- write the cause -> effect ledger (agent_id here is TEXT -> repid_agents.agent_id)
  INSERT INTO agent_repid_history
    (agent_id, task_id, repid_delta, payment_proof_hash,
     payment_amount_usdc, reason, created_at)
  VALUES
    (COALESCE(v_agent_text, NEW.agent_id::text), NULL, v_delta, COALESCE(NEW.metadata->>'tx_hash', NEW.idempotency_key, '0x_simulated'),
     NEW.economic_impact_usdc, NEW.event_type, now());

  RETURN NEW;
END;
$function$;
