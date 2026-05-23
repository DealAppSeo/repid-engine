-- Red Team — Economic Attack 4: Self-dealing (provider == buyer)
-- Block an agent from contracting with itself to mint RepID without external work.
-- Direct (same agent_id) self-dealing is cheap to forbid at the data layer; the
-- sock-puppet variant (one operator, two agent_ids) needs off-chain identity linking → V2.
--
-- Safe to apply: a deterministic scan found 0 existing rows with buyer_agent_id =
-- provider_agent_id, and no production flow legitimately creates such a contract.
-- Idempotent (guarded on pg_constraint); reversible via DROP CONSTRAINT.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_contracts_no_self_dealing'
      AND conrelid = 'service_contracts'::regclass
  ) THEN
    ALTER TABLE service_contracts
      ADD CONSTRAINT service_contracts_no_self_dealing
      CHECK (buyer_agent_id <> provider_agent_id);
  END IF;
END $$;
