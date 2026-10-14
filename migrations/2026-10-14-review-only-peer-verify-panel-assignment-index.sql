-- ==========================================================================================
-- REVIEW-ONLY — Sean-gated. Not applied by any workflow. Run by hand, OUTSIDE a transaction.
-- ==========================================================================================
-- Index for the panel assignment lookup in src/services/peer-verify-consensus.ts
-- (ASSIGNED_PANEL_CTE): trinity_tasks rows with task_type = 'peer_verify', agent_assigned in
-- PANEL_VERIFIER_POOL, created_at >= the queue row's created_at.
--
-- Today [V, prod EXPLAIN ANALYZE 2026-10-14, queue 142077] that shape is served by a BitmapAnd of
-- idx_trinity_tasks_agent_assigned_status (agent_assigned, status, priority) and
-- idx_trinity_tasks_created_at — 43 ms, reading ~230k index entries for the agent_assigned leg.
-- No index matches the shape itself. This partial index does, so the lookup stays fast as
-- trinity_tasks grows. Optional: the code already fails fast (one attempt, 2 s) if it is slow.
--
-- CONCURRENTLY avoids locking the write-hot table; it cannot run inside BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trinity_tasks_peer_verify_assigned_created
  ON trinity_tasks (agent_assigned, created_at)
  WHERE task_type = 'peer_verify';

-- Rollback:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_trinity_tasks_peer_verify_assigned_created;
