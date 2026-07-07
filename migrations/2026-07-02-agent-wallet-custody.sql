-- 2026-07-02 — Agent wallet provisioning (DB-custodied signing keys).
--
-- PURPOSE
--   Let a NEW human's agent sign/transact. Historically only the 12 pre-keyed
--   Trinity agents (env {AGENT}_PRIVATE_KEY) could sign; new agents got a fake
--   `0xAGENT_…` / `external:<uuid>` erc8004_address and NO key. This migration:
--     1. Ensures repid_agents.wallet_address exists (the REAL EVM address).
--     2. Creates agent_secrets to hold the AES-GCM-encrypted private key at rest.
--
-- ── SECURITY FLAG — HUMAN REVIEW REQUIRED (Sean's call) ─────────────────────
--   The encrypted_private_key blob is encrypted APPLICATION-SIDE with a single
--   symmetric master key in env (AGENT_KEY_MASTER). This is INTERIM custody so
--   agents can transact today. PRODUCTION must move to KMS / Vault envelope
--   encryption (per-secret data keys; master never in app memory). Do NOT put
--   real user funds behind the env-master-key scheme without that sign-off.
--   key_version tracks the master-key generation so rotation can decrypt-old /
--   re-encrypt-new. rotated_at is stamped when a row is re-encrypted.
-- ────────────────────────────────────────────────────────────────────────────
--
-- DO NOT AUTO-APPLY. Branch-only artifact. Apply via Sean/normal migration flow.
--
-- Tier safety: touches neither current_repid nor tier — trg_sync_tier not involved.
--
-- ROLLBACK (Sean, if needed):
--   DROP TABLE IF EXISTS public.agent_secrets;
--   -- wallet_address column intentionally NOT dropped on rollback (may hold
--   -- addresses already provisioned; drop manually only if truly unwinding):
--   -- ALTER TABLE public.repid_agents DROP COLUMN IF EXISTS wallet_address;

BEGIN;

-- 1. Real EVM address for the agent's custodied wallet. IF NOT EXISTS because
--    application code + database.types.ts already reference wallet_address; this
--    is a defensive guarantee, not a first-time add in most environments.
ALTER TABLE public.repid_agents
  ADD COLUMN IF NOT EXISTS wallet_address text;

-- 2. Encrypted private-key custody, one (or more, across rotations) per agent.
CREATE TABLE IF NOT EXISTS public.agent_secrets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              uuid NOT NULL REFERENCES public.repid_agents(id) ON DELETE CASCADE,
  -- AES-256-GCM blob: { v, iv, tag, ciphertext } (base64 fields). JSONB so the
  -- structured envelope is queryable and future-proof vs opaque text.
  encrypted_private_key jsonb NOT NULL,
  -- Which AGENT_KEY_MASTER generation encrypted this blob (see security flag).
  key_version           integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Stamped when this row's key is re-encrypted under a newer master key.
  rotated_at            timestamptz
);

-- Fast "latest secret for this agent" lookup (getDecryptedPrivateKey ordering).
CREATE INDEX IF NOT EXISTS idx_agent_secrets_agent_id_created
  ON public.agent_secrets (agent_id, created_at DESC);

-- RLS: agent_secrets holds key material — lock it down. Service-role (the
-- engine's SUPABASE_SERVICE_KEY) bypasses RLS; no permissive policy is added
-- deliberately, so anon/authenticated clients get zero rows.
ALTER TABLE public.agent_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_secrets FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.agent_secrets IS
  'AES-GCM-encrypted custodied wallet private keys for agents. INTERIM env-master-key custody; KMS/Vault is the production upgrade (Sean sign-off required).';
COMMENT ON COLUMN public.repid_agents.wallet_address IS
  'Real EVM address of the agent''s custodied signing wallet (private key in agent_secrets). Distinct from erc8004_address, which may be a non-EVM registry id.';

COMMIT;
