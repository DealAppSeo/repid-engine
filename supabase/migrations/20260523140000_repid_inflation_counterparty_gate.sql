-- RepID Inflation Patch B — minimum unique-counterparty tier gate.
--
-- ⚠️ DO NOT APPLY WITHOUT SEAN GREENLIGHT. Calibration (2026-05-23) shows the current population
-- has almost no counterparty diversity (ESTABLISHED median 0 / max 2; both AUTONOMOUS <=3), because
-- RepID today is earned mostly via non-service events, not service contracts. Demotion impact:
--   sprint thresholds (auto10/est5/earn3) -> 25/30 demoted
--   gentle (auto3/est2/earn1)             -> 19/30 demoted
--   grandfather (auto2/est1)              -> 10/30 demoted
--   zero-demote (auto2, est/earn ungated) -> 0/30 demoted   <-- DEFAULTS BELOW
-- See E:\dev\reports\2026-05-23\CC2_REPID_INFLATION_PATCHES.md §2 for the full table + decision.
--
-- Defaults ship as the zero-demotion ratchet floor: blocks a NEW agent from reaching AUTONOMOUS/
-- VETERAN without >=2 distinct counterparties, demotes nobody today. Ratchet est_min/earn_min up
-- as the service-contract economy matures. Backward compatible: the 1-arg compute_tier(integer) is
-- left untouched, so any caller not passing an agent_id keeps the pure score->tier behavior.
--
-- ROLLBACK: restore sync_tier() to `NEW.tier := compute_tier(NEW.current_repid);`,
--           DROP FUNCTION compute_tier(integer, uuid); DROP FUNCTION count_unique_counterparties(uuid);

-- 1) Distinct delivered counterparties for an agent as provider.
--    "delivered" includes resolved disputes (status reaches a terminal delivery/resolution);
--    the spec's fulfilled-only filter would miss disputed->resolved contracts.
CREATE OR REPLACE FUNCTION count_unique_counterparties(p_agent_id UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(DISTINCT buyer_agent_id)::INTEGER
  FROM service_contracts
  WHERE provider_agent_id = p_agent_id
    AND status IN ('fulfilled', 'satisfied', 'settled', 'resolved');
$$ LANGUAGE SQL STABLE;

-- 2) NEW 2-arg overload: score-based tier with a counterparty floor. Distinct arity from the
--    existing compute_tier(integer) — no call ambiguity. Cascades (an agent can drop >1 tier).
CREATE OR REPLACE FUNCTION compute_tier(p_repid INTEGER, p_agent_id UUID)
RETURNS TEXT AS $$
DECLARE
  -- TUNE THESE before ratcheting. Defaults = zero-demotion floor (0 current agents demoted).
  vet_min  INTEGER := 2;   -- target (mature economy): 10
  auto_min INTEGER := 2;   -- target: 5
  est_min  INTEGER := 0;   -- target: 3   (0 = ungated; any value >=1 demotes ~10 current agents)
  earn_min INTEGER := 0;   -- target: 1
  base_tier TEXT;
  cp INTEGER;
  v_is_human BOOLEAN;
BEGIN
  -- Existing score thresholds (must mirror compute_tier(integer)).
  base_tier := CASE
    WHEN p_repid >= 8000 THEN 'VETERAN'
    WHEN p_repid >= 5000 THEN 'AUTONOMOUS'
    WHEN p_repid >= 1000 THEN 'ESTABLISHED'
    WHEN p_repid >= 500  THEN 'EARNING'
    ELSE 'PROBATIONARY'
  END;

  IF p_agent_id IS NULL THEN
    RETURN base_tier;  -- backward compat: no gate without an agent id
  END IF;

  -- Exclude human/role accounts from the counterparty gate (Sean directive 2026-05-23): they don't
  -- provide services, so a counterparty floor shouldn't demote them.
  -- ⚠️ is_human is currently FALSE for all active rows (incl. the HUMAN/SEAN accounts). Populate it
  -- (UPDATE repid_agents SET is_human=true WHERE ...) BEFORE ratcheting est_min/earn_min >= 1, or
  -- those accounts will be demoted. At the zero-demotion floor below this exclusion is inert anyway.
  SELECT is_human INTO v_is_human FROM repid_agents WHERE id = p_agent_id;
  IF COALESCE(v_is_human, false) THEN
    RETURN base_tier;
  END IF;

  cp := count_unique_counterparties(p_agent_id);

  -- Counterparty floor, cascading top-down (sequential IFs, not ELSIF).
  IF base_tier = 'VETERAN'    AND cp < vet_min  THEN base_tier := 'AUTONOMOUS'; END IF;
  IF base_tier = 'AUTONOMOUS' AND cp < auto_min THEN base_tier := 'ESTABLISHED'; END IF;
  IF base_tier = 'ESTABLISHED' AND cp < est_min THEN base_tier := 'EARNING'; END IF;
  IF base_tier = 'EARNING'    AND cp < earn_min THEN base_tier := 'PROBATIONARY'; END IF;

  RETURN base_tier;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3) Activate the gate: point the tier trigger at the 2-arg overload.
--    After this, EVERY write to repid_agents recomputes tier WITH the counterparty floor.
CREATE OR REPLACE FUNCTION sync_tier()
RETURNS TRIGGER AS $$
BEGIN
  NEW.tier := compute_tier(NEW.current_repid, NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
