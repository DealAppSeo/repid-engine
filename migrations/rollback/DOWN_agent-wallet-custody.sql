-- DOWN migration for migrations/2026-07-02-agent-wallet-custody.sql
--
-- The UP does TWO things:
--   1. CREATE TABLE agent_secrets           → cleanly reversible (DROP below).
--   2. ADD COLUMN repid_agents.wallet_address → NOT auto-reversed here.
--
-- ⚠ PARTIAL REVERSIBILITY — HONEST NOTE:
--   agent_secrets DROP is clean. The wallet_address COLUMN is intentionally NOT
--   dropped, exactly as the UP's own rollback header instructs ("wallet_address
--   column intentionally NOT dropped on rollback (may hold addresses already
--   provisioned)"). Dropping it would DESTROY any real EVM addresses already
--   written for custodied agents — that is DATA LOSS, not a schema no-op.
--   → For the column: FORWARD-FIX ONLY. Leave it. It is additive + nullable and
--     harmless if unused. Only drop it manually, deliberately, if truly unwinding
--     custody entirely AND you have confirmed no agent holds a provisioned address.
--
-- The reversibility-test transcript below (dev branch) drops BOTH (table + column)
-- to PROVE the mechanics reverse, on a throwaway branch with NO real data. In
-- PROD, run only the agent_secrets DROP.

-- (1) Always safe: custody table.
DROP TABLE IF EXISTS public.agent_secrets CASCADE;

-- (2) Column drop — PROD: DO NOT RUN (data loss). Dev-branch reversibility test
--     ONLY, where the branch has no provisioned addresses. Kept commented so a
--     paste into prod does not silently wipe wallet_address.
-- ALTER TABLE public.repid_agents DROP COLUMN IF EXISTS wallet_address;
