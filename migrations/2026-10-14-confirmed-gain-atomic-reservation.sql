-- CONFIRMED GAIN: ATOMIC RECEIPT CLAIM + DAY/DOMAIN BUDGET RESERVATION — review-only DDL (2026-10-14)
--
-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED. REVIEW-ONLY. Sean applies prod DDL; no agent lane does.                         ║
-- ║  As written this file ends in ROLLBACK, so running it changes nothing. To apply: change the  ║
-- ║  final ROLLBACK to COMMIT on a logged decision.                                              ║
-- ║  Arms nothing. CONFIRMED_OUTCOME_SCORING_ENABLED stays OFF and is the only thing that calls  ║
-- ║  this function. Until it exists, the engine pays NO confirmed gain (fail closed, logged).     ║
-- ║  The function reads public.kernel_receipts at call time, so apply it with or after           ║
-- ║  supabase/migrations/20261013000000_kernel_receipts.sql and                                  ║
-- ║  migrations/2026-10-14-kernel-receipts-content-claim.sql (both unapplied on 2026-10-14).     ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY (XC1 re-attack of #1364, finding 1, S1). The engine read today's confirmed-gain sum from
-- repid_score_events, then claimed the receipt, then inserted the audit row. Nothing locked in
-- between, so N parallel requests that all read before any insert landed each took a full gain:
-- one burst spent the HTTP rate limit, not the day cap. A read outside the claim is not a budget.
--
-- WHAT. One function, one transaction, called by src/engine/repid-update.ts::reserveConfirmedGain:
--   (1) LOCK   insert-if-absent + SELECT … FOR UPDATE on this agent's whole-UTC-day row
--              (budget_domain = ''), then on the domain row. Every gain for one agent-day queues on
--              the day row, so the sums below cannot be stale. One lock order, so no deadlock.
--   (2) GRANT  min(p_gain, p_day_cap - day spent, p_domain_cap - domain spent), floored at 0.
--              The caps are PARAMETERS: their magnitudes live in env, not in this public repo or DB.
--   (3) CLAIM  UPDATE kernel_receipts … WHERE receipt_id AND subject_agent_id AND VERIFIED AND
--              consumed_at IS NULL, in the same transaction. The content index's 23505
--              (kernel_receipts_one_gain_per_content) is caught as 'content_already_claimed'.
--   (4) BOOK   add the grant to the day row and the domain row.
--   Anything that stops before (4) books nothing. Wrongs do not come here: they are not capped and
--   keep the existing one-statement claim (claimConfirmationReceipt).
--
-- budget_domain '' is the whole-day row. The engine's domain key (normalizeCapDomain: NFKC, format
-- characters stripped, whitespace collapsed, trimmed, lower-cased) is never '': an empty key is no
-- gain and never reaches this function. The function also refuses '' itself (invalid_input).
--
-- VERIFIED SO FAR: [R] only. This SQL has NOT been executed against Postgres (no local Postgres on the
-- authoring machine, and prod DDL is out of lane). tests/confirmed-outcome-atomic-cap.test.ts drives
-- the engine against an in-memory model of this exact function (tests/helpers/fake-claim-confirmed-gain.ts)
-- and string-pins the properties above. A green suite proves the engine and the model agree, NOT that
-- this file runs. Run the POST-APPLY checks at the bottom before the flag can see a gain.

BEGIN;

CREATE TABLE IF NOT EXISTS public.confirmed_gain_budget (
  agent_id      text        NOT NULL,
  utc_day       date        NOT NULL,
  budget_domain text        NOT NULL,          -- '' = the whole-day row; else the normalized domain key
  spent         integer     NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, utc_day, budget_domain)
);

-- Service role only. RLS on with no policies blocks anon/authenticated even if a default grant exists.
ALTER TABLE public.confirmed_gain_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.confirmed_gain_budget FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_confirmed_gain(
  p_receipt_id text,
  p_agent_id   text,
  p_domain     text,
  p_gain       integer,
  p_day_cap    integer,
  p_domain_cap integer
)
RETURNS TABLE (outcome text, granted integer, day_spent integer, domain_spent integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_day       date := (now() AT TIME ZONE 'UTC')::date;
  v_day_spent integer;
  v_dom_spent integer;
  v_grant     integer;
  v_claimed   text;
BEGIN
  IF p_receipt_id IS NULL OR btrim(p_receipt_id) = ''
     OR p_agent_id IS NULL OR btrim(p_agent_id) = ''
     OR p_domain IS NULL OR btrim(p_domain) = ''
     OR p_gain IS NULL OR p_gain <= 0
     OR p_day_cap IS NULL OR p_day_cap < 0
     OR p_domain_cap IS NULL OR p_domain_cap < 0 THEN
    RETURN QUERY SELECT 'invalid_input'::text, 0, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- (1) LOCK: the whole-day row first, then the domain row.
  INSERT INTO confirmed_gain_budget (agent_id, utc_day, budget_domain)
  VALUES (p_agent_id, v_day, '')
  ON CONFLICT DO NOTHING;
  SELECT b.spent INTO v_day_spent
    FROM confirmed_gain_budget b
   WHERE b.agent_id = p_agent_id AND b.utc_day = v_day AND b.budget_domain = ''
     FOR UPDATE;

  INSERT INTO confirmed_gain_budget (agent_id, utc_day, budget_domain)
  VALUES (p_agent_id, v_day, p_domain)
  ON CONFLICT DO NOTHING;
  SELECT b.spent INTO v_dom_spent
    FROM confirmed_gain_budget b
   WHERE b.agent_id = p_agent_id AND b.utc_day = v_day AND b.budget_domain = p_domain
     FOR UPDATE;

  -- (2) GRANT, from sums read under the lock.
  v_grant := GREATEST(0, LEAST(p_gain, p_day_cap - v_day_spent, p_domain_cap - v_dom_spent));
  IF v_grant = 0 THEN
    RETURN QUERY SELECT 'capped_to_zero'::text, 0, v_day_spent, v_dom_spent;
    RETURN;
  END IF;

  -- (3) CLAIM, same transaction. A gain may only spend a VERIFIED receipt about this agent.
  BEGIN
    UPDATE kernel_receipts k
       SET consumed_at = now()
     WHERE k.receipt_id = p_receipt_id
       AND k.subject_agent_id = p_agent_id
       AND k.verification_status = 'VERIFIED'
       AND k.consumed_at IS NULL
    RETURNING k.receipt_id INTO v_claimed;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'content_already_claimed'::text, 0, v_day_spent, v_dom_spent;
    RETURN;
  END;
  IF v_claimed IS NULL THEN
    RETURN QUERY SELECT 'receipt_not_claimable'::text, 0, v_day_spent, v_dom_spent;
    RETURN;
  END IF;

  -- (4) BOOK on both rows, still under the lock.
  UPDATE confirmed_gain_budget b
     SET spent = b.spent + v_grant, updated_at = now()
   WHERE b.agent_id = p_agent_id AND b.utc_day = v_day AND b.budget_domain IN ('', p_domain);

  RETURN QUERY SELECT 'granted'::text, v_grant, v_day_spent, v_dom_spent;
END;
$fn$;

-- Callable by the engine's service role only. Without the REVOKE, Supabase's default grants would let
-- the anon key call it and burn any agent's receipts and day budget.
REVOKE ALL ON FUNCTION public.claim_confirmed_gain(text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_confirmed_gain(text, text, text, integer, integer, integer) TO service_role;

ROLLBACK;  -- REVIEW-ONLY. Change to COMMIT only on a logged decision.

-- ── POST-APPLY CHECKS (read-only; run after COMMIT, before the flag can see a gain) ──────────────
-- SELECT p.proname, p.prosecdef FROM pg_proc p WHERE p.proname = 'claim_confirmed_gain';      -- 1 row, prosecdef = false
-- SELECT has_function_privilege('anon',          'public.claim_confirmed_gain(text,text,text,integer,integer,integer)', 'EXECUTE'); -- false
-- SELECT has_function_privilege('authenticated', 'public.claim_confirmed_gain(text,text,text,integer,integer,integer)', 'EXECUTE'); -- false
-- SELECT has_function_privilege('service_role',  'public.claim_confirmed_gain(text,text,text,integer,integer,integer)', 'EXECUTE'); -- true
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.confirmed_gain_budget'::regclass;    -- true

-- ── DOWN ──────────────────────────────────────────────────────────────────────────────────────
-- With the function gone, reserveConfirmedGain's RPC errors and every confirmed GAIN fails closed to
-- zero (logged). Wrongs are unaffected. The safe direction.
-- DROP FUNCTION IF EXISTS public.claim_confirmed_gain(text, text, text, integer, integer, integer);
-- DROP TABLE IF EXISTS public.confirmed_gain_budget;
