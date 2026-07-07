-- Anti-Sybil MVP (2026-07-07) — exclude SIMULATED counterparties from the tier floor.
--
-- ⚠️ MIGRATION FILE ONLY — DO NOT APPLY WITHOUT SEAN GREENLIGHT.
-- Design: E:\dev\living-docs\03_specs\REPID_ECONOMIC_DESIGN_v1.md §6 (T2 hole #3).
-- Red-team: E:\dev\reports\2026-07-07\T2_SYBIL_FARMING_REDTEAM.md §1.5 / §4 rank 2.
--
-- T2 HOLE: count_unique_counterparties() filters only on status
-- IN ('fulfilled','satisfied','settled','resolved'). It does NOT exclude
-- SIMULATED contracts, so the AUTONOMOUS 2-counterparty floor is cleared by
-- 2 free sockpuppet buyers on simulated/self-dealt contracts. "distinct
-- counterparty" != "distinct paying human".
--
-- FIX: count a buyer only when at least one of their delivered contracts with
-- this provider is NON-simulated. A contract is SIMULATED when:
--   (a) its linked x402_settlements row (service_contracts.x402_payment_id) has
--       is_simulated = true, OR
--   (b) metadata->>'is_simulated' or payload->>'is_simulated' is truthy
--       ('true'/'1'/'yes', case-insensitive — mirrors src/utils/truthy.ts).
-- NOTE: service_contracts has NO is_simulated column (verified prod schema
-- 2026-07-07); the flag lives on the settlement row or in jsonb only.
--
-- CONFIG-DRIVEN, DEFAULT OFF (zero-demotion discipline — same as the counterparty
-- gate migration that this extends). Gated by repid_config key
-- 'count_counterparties_exclude_simulated' (default 'false'). While OFF, the
-- function behaves EXACTLY as the deployed body (counts all delivered buyers) —
-- no agent is demoted on apply. Flip to 'true' only AFTER a proof-of-cost bond
-- exists (else it just raises the sockpuppet count, per T2 §4 rank 2).
--
-- ROLLBACK: restore count_unique_counterparties(uuid) to the deployed body:
--   SELECT COUNT(DISTINCT buyer_agent_id)::INTEGER FROM service_contracts
--   WHERE provider_agent_id = p_agent_id
--     AND status IN ('fulfilled','satisfied','settled','resolved');

-- 0) Config flag row (idempotent). Default 'false' = no behavior change.
INSERT INTO repid_config (key, value, description)
VALUES (
  'count_counterparties_exclude_simulated',
  'false',
  'Anti-Sybil: when true, count_unique_counterparties excludes buyers whose only delivered contracts with the provider are simulated. Default false (zero-demotion). Flip true only after proof-of-cost bond ships.'
)
ON CONFLICT (key) DO NOTHING;

-- 1) Helper: is a single contract non-simulated? (real settlement OR no sim flag)
--    Kept as a plain boolean expression via a STABLE function for reuse + clarity.
CREATE OR REPLACE FUNCTION contract_is_non_simulated(p_contract service_contracts)
RETURNS BOOLEAN AS $$
  SELECT NOT (
    -- (a) linked settlement is simulated
    COALESCE(
      (SELECT s.is_simulated FROM x402_settlements s WHERE s.id = p_contract.x402_payment_id),
      false
    )
    -- (b) metadata / payload sim flag truthy (true/1/yes, case-insensitive)
    OR LOWER(COALESCE(p_contract.metadata ->> 'is_simulated', '')) IN ('true','1','yes')
    OR LOWER(COALESCE(p_contract.payload  ->> 'is_simulated', '')) IN ('true','1','yes')
  );
$$ LANGUAGE SQL STABLE;

-- 2) Re-define count_unique_counterparties with the config-gated exclusion.
--    OFF (default): identical to the deployed body. ON: distinct buyers who have
--    >= 1 NON-simulated delivered contract with this provider.
CREATE OR REPLACE FUNCTION count_unique_counterparties(p_agent_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_exclude BOOLEAN;
BEGIN
  SELECT LOWER(COALESCE(value, 'false')) IN ('true','1','yes')
    INTO v_exclude
  FROM repid_config
  WHERE key = 'count_counterparties_exclude_simulated';
  v_exclude := COALESCE(v_exclude, false);

  IF NOT v_exclude THEN
    -- Deployed behavior (unchanged): all delivered buyers count.
    RETURN (
      SELECT COUNT(DISTINCT buyer_agent_id)::INTEGER
      FROM service_contracts
      WHERE provider_agent_id = p_agent_id
        AND status IN ('fulfilled', 'satisfied', 'settled', 'resolved')
    );
  END IF;

  -- Excluded: a buyer counts only if it has >= 1 NON-simulated delivered contract.
  RETURN (
    SELECT COUNT(DISTINCT sc.buyer_agent_id)::INTEGER
    FROM service_contracts sc
    WHERE sc.provider_agent_id = p_agent_id
      AND sc.status IN ('fulfilled', 'satisfied', 'settled', 'resolved')
      AND contract_is_non_simulated(sc)
  );
END;
$$ LANGUAGE plpgsql STABLE;
