-- ─────────────────────────────────────────────────────────────────────────────
-- trinity_tasks INDEX CONSOLIDATION — DRAFT, NOT APPLIED  (CC, 2026-06-24 round 3)
-- HARD STOP: nothing here is applied. DROP INDEX on Trinity prod (qnnpjhlxljtqyigedwkb)
-- is a Tier-2 / Sean-only, Railway/prod-gated DDL action. Reviewable artifact only.
-- Grounded in READ-ONLY pg_indexes + pg_stat_user_indexes (RULE-5 schema-first).
--
-- CONTEXT: round-2 found idx_tasks_status and idx_trinity_tasks_status are IDENTICAL
-- duplicates (both `btree(status)`). The brief said: confirm which is canonical before
-- drafting the DROP — do NOT guess. So I checked actual planner usage. The result is
-- COUNTER-INTUITIVE and is exactly why guessing by name would have caused a regression.
-- ─────────────────────────────────────────────────────────────────────────────

-- ===== VERIFIED USAGE (pg_stat_user_indexes, read-only, 2026-06-24) [V] =====
--   index                      | idx_scan   | size    | verdict
--   ---------------------------+------------+---------+------------------------------
--   idx_tasks_status           |  5,828,837 | 3944 kB | HOT  -> KEEP (canonical)
--   idx_trinity_tasks_status   |          3 | 4248 kB | DEAD -> DROP (redundant dup)
--   idx_tasks_priority (DESC)  |    234,912 | 4088 kB | used -> KEEP
--   idx_trinity_tasks_priority |     95,071 | 4024 kB | used -> KEEP (see note)
--
-- ⚠ Naming would have misled: idx_trinity_tasks_status *looks* canonical, but the planner
--   has used it 3 times vs 5.8M for idx_tasks_status. Usage stats decide, not the name.

-- ===== THE SAFE CONSOLIDATION (one dead, exact-duplicate index) =====
-- Both are `CREATE INDEX ... ON public.trinity_tasks USING btree (status)` — byte-identical
-- definition, so dropping the unused one removes pure write-amplification with zero read loss.
-- CONCURRENTLY = no lock on the live claim/poll path. Cannot run inside a txn block; run standalone.
-- Re-confirm idx_scan is still ~0 immediately before applying (a plan can shift).

-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_trinity_tasks_status;   -- keep idx_tasks_status (5.8M scans)

-- ===== NOT recommended in this draft (would need EXPLAIN evidence first) =====
-- idx_tasks_priority (priority DESC) vs idx_trinity_tasks_priority (priority ASC):
--   For a single-column btree, ASC and DESC can both serve ordering in either direction, so
--   ONE could in principle serve both. BUT both are actively used (235k / 95k scans), and
--   idx_trinity_tasks_priority shows ~18.8B tuples read — it backs large/low-selectivity scans.
--   Dropping either could regress real query plans. DO NOT drop without per-query EXPLAIN
--   (ANALYZE, BUFFERS) showing the survivor covers both access patterns. Flag, do not guess.

-- ===== TRIGGER REVIEW (8 on trinity_tasks) — NO exact redundancy found =====
-- Verified defs (pg_trigger, read-only). Each calls a DISTINCT function; none are duplicates:
--   BEFORE INSERT : auto_fix_task_status(fix_task_status_on_insert), trg_auto_lineage(auto_lineage),
--                   trg_normalize_agent_names(auto_normalize_agent_names), trigger_throttle_healing(throttle_healing_tasks)
--   BEFORE UPDATE : trg_auto_escalate(fn_auto_escalate_failed_task), trg_protect_key_tasks(prevent_clarification_on_protected),
--                   trg_normalize_agent_names (also fires on UPDATE), update_trinity_tasks_updated_at(update_updated_at_column)
--   AFTER  UPDATE : trg_task_completion_learning(trigger_task_completion_learning)
-- Observation (not a drop recommendation): 4 BEFORE INSERT triggers fire per task creation; they
-- COULD be consolidated into fewer functions to cut per-row overhead — but each encodes distinct
-- business logic, so that is a BEHAVIOR-CHANGING refactor requiring each function body to be read
-- and re-tested. Out of scope for a safe DRAFT (RULE-3: fix only the named, verified-redundant thing).
-- The verified, safe win here is the single dead duplicate index above.

-- VERDICT: apply (Sean, after re-checking idx_scan) ONLY the one CONCURRENTLY drop above.
-- Everything else is a flagged follow-up needing EXPLAIN / function-body review. Nothing applied.
