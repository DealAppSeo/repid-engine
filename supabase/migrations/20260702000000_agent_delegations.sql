-- ============================================================================
-- Explicit human → agent authorization  (agent_delegations)
--
-- Today an agent's authority to spend is only IMPLICIT: repid_agents.builder_id
-- links an agent to the human (builders.id) that owns it, and the settlement
-- path (x402-gate) checks tier/stake but never checks a signed grant.
-- payment_log.delegation_chain exists but is never written.
--
-- This table makes the human → agent grant EXPLICIT and cryptographically
-- verifiable: a delegator (human builder) signs an EIP-712 message
-- "I, <delegator_address>, authorize agent <agent_id> to spend up to <max>
-- until <expiry>". The signature must recover to delegator_address, and that
-- address must own the agent (repid_agents.builder_id -> builders.address).
--
-- Enforcement is gated behind the DELEGATION_REQUIRED env flag (default OFF),
-- so applying this table alone does NOT change runtime behavior.
--
-- DO NOT APPLY blindly — schema is managed externally (Supabase MCP). This file
-- is committed for review/reproducibility. All columns additive; no existing
-- table is modified.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_delegations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO granted the authority (the human).
  delegator_builder_id  UUID NOT NULL REFERENCES builders(id),
  delegator_address     TEXT NOT NULL,                 -- wallet that signed (checksummed or lowercase)

  -- WHICH agent received it. Text to match repid_agents.agent_name usage in the
  -- settlement path (x402-gate keys on agent_name), not the UUID pk.
  agent_id              TEXT NOT NULL,

  -- WHAT was granted. JSON scope, e.g. {"max_usdc_per_tx": 100, "max_usdc_total": 1000}.
  scope_json            JSONB NOT NULL,

  -- WHEN it lapses.
  expires_at            TIMESTAMPTZ NOT NULL,

  -- PROOF. The raw EIP-712 signature (0x-prefixed, 65-byte / 132-char hex).
  signature             TEXT NOT NULL,

  -- Revocation + creation bookkeeping.
  revoked_at            TIMESTAMPTZ,                   -- NULL = live
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup path for enforcement: "live delegations for this agent".
-- Partial index on the hot predicate (unrevoked + unexpired is filtered in code,
-- but revoked_at IS NULL is the cheap prefilter).
CREATE INDEX IF NOT EXISTS idx_agent_delegations_agent_live
  ON agent_delegations(agent_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_delegations_delegator
  ON agent_delegations(delegator_builder_id);

CREATE INDEX IF NOT EXISTS idx_agent_delegations_expires
  ON agent_delegations(expires_at);
