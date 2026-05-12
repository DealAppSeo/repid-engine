-- ================================================================
-- CC Sprint 6 — heartbeat interval tracking on trinity_heartbeat
-- 2026-05-11 evening
-- ================================================================
-- Defensive against the failure mode that bit us today: the recurring
-- heartbeat in ConstitutionalAgentV4.js:153-157 was commented out by
-- the [ANTIGRAVITY] ARBITRAGE change (commit 6b7155679 on 2026-02-18),
-- and there was no signal in the data to detect it. Workers were
-- silent for 84+ days before anyone noticed.
--
-- This migration adds:
--   trinity_heartbeat.heartbeat_interval_ms INTEGER NULL
-- Each heartbeat write should record the agent's current configured
-- interval so:
--   - NULL (column not populated) → flag for review (likely an old
--     agent version that doesn't write this field yet)
--   - heartbeat_interval_ms IS NULL OR > 600000 (10 min) → flag in
--     trinity_swarm_health view as "interval-disabled-or-stale"
--
-- The ConstitutionalAgentV4.js patch (in CC_SPRINT_6_REPORT.md) should
-- populate this field as part of the heartbeat() function. Until that
-- patch ships, the column stays NULL for all rows — which is itself
-- the signal: "no agent is reporting a recurring interval; recurring
-- heartbeat may be disabled."
--
-- This is observability infrastructure, not a fix. The fix is the
-- ConstitutionalAgentV4.js patch.
-- ================================================================

ALTER TABLE public.trinity_heartbeat
  ADD COLUMN IF NOT EXISTS heartbeat_interval_ms INTEGER;

COMMENT ON COLUMN public.trinity_heartbeat.heartbeat_interval_ms IS
  'Recurring heartbeat interval the agent reports it is using, in ms. '
  'NULL means the agent is not reporting (likely old version, or '
  'recurring heartbeat is disabled). Values > 600000 (10 min) flag '
  'for review. Populated by ConstitutionalAgentV4.js heartbeat() once '
  'the CC Sprint 6 patch is applied. CC Sprint 6 (2026-05-11).';

-- Rollback:
--   ALTER TABLE public.trinity_heartbeat DROP COLUMN IF EXISTS heartbeat_interval_ms;
