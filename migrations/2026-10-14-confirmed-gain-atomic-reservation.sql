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
--   (0) CEIL   read the server-side ceiling (confirmed_gain_cap_config, filled at apply time) and use
--              LEAST(caller cap, server cap). No row → RAISE: no gain books without a ceiling.
--   (1) LOCK   insert-if-absent + SELECT … FOR UPDATE on this agent's whole-UTC-day row
--              (budget_domain = ''), then on the domain row. Every gain for one agent-day queues on
--              the day row, so the sums below cannot be stale. One lock order, so no deadlock.
--              A row that cannot be read under the lock RAISES (a NULL spent would make LEAST() grant
--              the full gain).
--   (2) GRANT  min(p_gain, day cap - day spent, domain cap - domain spent), floored at 0. No
--              magnitude is in this public file: the env supplies the caller's caps, the config row the
--              server's.
--   (3) CLAIM  UPDATE kernel_receipts … WHERE receipt_id AND subject_agent_id AND VERIFIED AND
--              consumed_at IS NULL, in the same transaction. The content index's 23505
--              (kernel_receipts_one_gain_per_content) is caught as 'content_already_claimed'.
--   (4) BOOK   add the grant to the day row and the domain row; anything but exactly 2 rows RAISES.
--   A RAISE aborts the whole call, the receipt claim included. Anything that stops before (4) books
--   nothing. Wrongs do not come here: they are not capped and keep the existing one-statement claim
--   (claimConfirmationReceipt).
--
-- budget_domain '' is the whole-day row. The engine's domain key (normalizeCapDomain: NFKC, invisible
-- characters stripped, whitespace collapsed, trimmed, lower-cased, and refused unless printable ASCII)
-- is never ''. The function refuses '' and any key that is not trimmed, lower-case printable ASCII
-- (invalid_input), so a direct service-role call cannot mint look-alike budget rows either.
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

-- THE SERVER-SIDE CEILING (XC1 review of #1369, residual b). The caller passes its env caps, but the
-- function books against LEAST(caller cap, this row), so a second caller or a replica with a higher
-- REPID_SMALL_GAIN_PER_DAY_CAP cannot raise what one agent-day may book. One row (id is always true).
-- The MAGNITUDES are not in this public file: Sean inserts them at apply time (template below). With no
-- row the function RAISES, so every gain fails closed until the ceiling exists.
CREATE TABLE IF NOT EXISTS public.confirmed_gain_cap_config (
  id             boolean     PRIMARY KEY DEFAULT true CHECK (id),
  per_day_cap    integer     NOT NULL CHECK (per_day_cap > 0),
  per_domain_cap integer     NOT NULL CHECK (per_domain_cap > 0 AND per_domain_cap <= per_day_cap),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.confirmed_gain_cap_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.confirmed_gain_cap_config FROM PUBLIC, anon, authenticated;
-- AT APPLY TIME, with the production magnitudes (the same values as the env vars; never commit them):
-- INSERT INTO public.confirmed_gain_cap_config (per_day_cap, per_domain_cap) VALUES (<per-day>, <per-domain>);

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
  v_day_cap   integer;
  v_dom_cap   integer;
  v_booked    integer;
BEGIN
  IF p_receipt_id IS NULL OR btrim(p_receipt_id) = ''
     OR p_agent_id IS NULL OR btrim(p_agent_id) = ''
     OR p_domain IS NULL OR btrim(p_domain) = ''
     -- the engine's key is normalized printable ASCII (normalizeCapDomain); refuse anything else so a
     -- direct service-role call cannot mint look-alike budget rows either
     OR p_domain !~ '^[!-~]([ -~]*[!-~])?$' OR p_domain <> lower(p_domain)
     OR p_gain IS NULL OR p_gain <= 0
     OR p_day_cap IS NULL OR p_day_cap < 0
     OR p_domain_cap IS NULL OR p_domain_cap < 0 THEN
    RETURN QUERY SELECT 'invalid_input'::text, 0, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- (0) CEILING: the server's, not only the caller's. No config row → RAISE (fail closed).
  SELECT c.per_day_cap, c.per_domain_cap INTO v_day_cap, v_dom_cap
    FROM confirmed_gain_cap_config c WHERE c.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed_gain_cap_config has no row: no confirmed gain can be booked';
  END IF;
  v_day_cap := LEAST(p_day_cap, v_day_cap);
  v_dom_cap := LEAST(p_domain_cap, v_dom_cap);

  -- (1) LOCK: the whole-day row first, then the domain row.
  INSERT INTO confirmed_gain_budget (agent_id, utc_day, budget_domain)
  VALUES (p_agent_id, v_day, '')
  ON CONFLICT DO NOTHING;
  SELECT b.spent INTO v_day_spent
    FROM confirmed_gain_budget b
   WHERE b.agent_id = p_agent_id AND b.utc_day = v_day AND b.budget_domain = ''
     FOR UPDATE;
  -- (XC1 residual a) A missed read must not leave v_day_spent NULL: LEAST() ignores NULL, which would
  -- turn the grant into the full p_gain. Under Read Committed the row inserted above is visible; under
  -- any other isolation it may not be, and then this raises instead of over-granting.
  IF NOT FOUND OR v_day_spent IS NULL THEN
    RAISE EXCEPTION 'confirmed_gain_budget day row not readable under lock (agent %, day %)', p_agent_id, v_day;
  END IF;

  INSERT INTO confirmed_gain_budget (agent_id, utc_day, budget_domain)
  VALUES (p_agent_id, v_day, p_domain)
  ON CONFLICT DO NOTHING;
  SELECT b.spent INTO v_dom_spent
    FROM confirmed_gain_budget b
   WHERE b.agent_id = p_agent_id AND b.utc_day = v_day AND b.budget_domain = p_domain
     FOR UPDATE;
  IF NOT FOUND OR v_dom_spent IS NULL THEN
    RAISE EXCEPTION 'confirmed_gain_budget domain row not readable under lock (agent %, day %, domain %)', p_agent_id, v_day, p_domain;
  END IF;

  -- (2) GRANT, from sums read under the lock.
  v_grant := GREATEST(0, LEAST(p_gain, v_day_cap - v_day_spent, v_dom_cap - v_dom_spent));
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
  GET DIAGNOSTICS v_booked = ROW_COUNT;
  IF v_booked <> 2 THEN
    -- the receipt claim above rolls back with this: nothing is spent that was not booked
    RAISE EXCEPTION 'confirmed_gain_budget booking touched % rows, expected 2', v_booked;
  END IF;

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
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.confirmed_gain_cap_config'::regclass; -- true
-- SELECT count(*) FROM public.confirmed_gain_cap_config;                                        -- 1 (else no gain books)

-- ── DOWN ──────────────────────────────────────────────────────────────────────────────────────
-- With the function gone, reserveConfirmedGain's RPC errors and every confirmed GAIN fails closed to
-- zero (logged). Wrongs are unaffected. The safe direction.
-- DROP FUNCTION IF EXISTS public.claim_confirmed_gain(text, text, text, integer, integer, integer);
-- DROP TABLE IF EXISTS public.confirmed_gain_budget;
-- DROP TABLE IF EXISTS public.confirmed_gain_cap_config;
