-- ============================================================================
-- DRAFT — trinity_tasks bleed-fix: archive terminal-state rows to history.
-- STATUS: DRAFT / DO NOT EXECUTE. Irreversible structural change → Sean eyes-on.
-- Author: CC 2026-06-30. Branch: feat/cc-2026-06-29-v3.1-audit-atomic-penalty.
-- Problem: trinity_tasks = 483 MB / ~267k rows; count(*) times out at 6s; can't fit MICRO cache
--          → latent bleed risk (any concurrency re-thrashes). ~250k of the rows are terminal-state
--          history (archived/done/cancelled/failed/shadow_reject), not live work.
-- Constraint: 26 FK children reference trinity_tasks.id — 6 ON DELETE CASCADE, 2 SET NULL, 18 NO ACTION.
--          A NO ACTION child with rows BLOCKS the parent delete → this is NOT a simple move.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- RECOMMENDED ORDER OF OPERATIONS (lowest-risk first; Sean decides how far to go)
-- ----------------------------------------------------------------------------
-- STEP 0 (do this FIRST — cheap, reversible-ish, may be enough on its own):
--   Reclaim dead-tuple bloat from the agent-churn. The rows are LIVE (valid statuses), so this only
--   reclaims bloat, not the 250k rows — but the table grew 474→483MB under the storm, so measure it.
--   VACUUM (ANALYZE) public.trinity_tasks;            -- non-blocking, safe, run anytime
--   -- If a hard shrink is needed and a brief ACCESS EXCLUSIVE lock window is acceptable (agents pause):
--   -- VACUUM FULL public.trinity_tasks;              -- rewrites compact; needs ~2x table disk on Supabase
--   -- (Supabase disk was ~29% used = ample). Prefer pg_repack if available (online, no long lock).
--   Re-measure pg_total_relation_size after. If it fits cache, STOP HERE — skip the archive below.

-- STEP 1 — history table (archive sink; NO FKs, it's cold storage):
CREATE TABLE IF NOT EXISTS public.trinity_tasks_history (LIKE public.trinity_tasks INCLUDING DEFAULTS INCLUDING STORAGE);
-- (Deliberately NOT "INCLUDING CONSTRAINTS/INDEXES" — archive needs no FK/triggers; add a PK on id only.)
ALTER TABLE public.trinity_tasks_history ADD PRIMARY KEY (id);
ALTER TABLE public.trinity_tasks_history ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT now();

-- Define the archive set ONCE (terminal status + aged). Tune the interval with Sean.
-- (Preserve claude-dispatch + anything recent; only long-settled terminal rows move.)
--   WHERE status IN ('archived','done','cancelled','failed','shadow_reject')
--     AND created_at < now() - interval '14 days'

-- ----------------------------------------------------------------------------
-- STEP 2 — FK CHILD HANDLING (the hard part). For the archive set's ids, children must be resolved
-- BEFORE the parent delete or the NO ACTION constraints abort it. Per on-delete action:
-- ----------------------------------------------------------------------------
--   ON DELETE CASCADE (6) — auto-removed with the parent (acceptable; they're historical too):
--       repid_votes, trinity_collaborations, trinity_bids, trinity_hitl_requests,
--       substance_gate_events, validation_queue
--   ON DELETE SET NULL (2) — child.task_id auto-nulled (acceptable):
--       trinity_agent_credits, trinity_whistleblower_reports
--   ON DELETE NO ACTION (18) — MUST be emptied of references to the archive set first, else the delete fails:
--       trinity_mcp_handoffs, verification_votes, trinity_tasks(parent_task_id self-ref),
--       trinity_shofet_rulings, ideation, idea_injections, antigravity_prompt_queue, task_verifications,
--       confidence_stakes, failure_analysis(failed_task_id + spawned_prevention_task_id),
--       private.trinity_learned_patterns, trinity_task_votes, trinity_protected_tasks,
--       trinity_hitl_decisions, task_verification_stakes, hitl_requests, task_escalations
--   → For each NO ACTION child: EITHER (a) archive+delete its rows that reference the archive set
--     (recommended for audit-bearing children: copy to <child>_history then delete), OR (b) if the child
--     is itself disposable for terminal tasks, just delete. Self-ref parent_task_id: archive children
--     before/with parents (process leaf tasks first, or set parent_task_id=NULL on archived children).
--   ⚠ Before running: SELECT count(*) per child WHERE task_id IN (archive set) to size each — several may be 0.

-- ----------------------------------------------------------------------------
-- STEP 3 — CHUNKED copy-then-delete (avoids a giant lock + the count timeout). Repeat until 0 rows.
-- Run in a transaction PER CHUNK; keep chunks small (e.g. 5k) given the contended pool.
-- ----------------------------------------------------------------------------
-- WITH ids AS (
--   SELECT id FROM public.trinity_tasks
--   WHERE status IN ('archived','done','cancelled','failed','shadow_reject')
--     AND created_at < now() - interval '14 days'
--     AND insert_source IS DISTINCT FROM 'claude-dispatch'
--   ORDER BY id LIMIT 5000 FOR UPDATE SKIP LOCKED            -- SKIP LOCKED avoids agent-claim contention
-- ),
-- moved AS (
--   INSERT INTO public.trinity_tasks_history
--   SELECT t.*, now() FROM public.trinity_tasks t JOIN ids USING (id)
--   RETURNING id
-- )
-- -- (handle NO ACTION children for `moved.id` here — per STEP 2 — before the parent delete)
-- DELETE FROM public.trinity_tasks WHERE id IN (SELECT id FROM moved);
-- -- after the loop drains: VACUUM (ANALYZE) public.trinity_tasks;

-- ----------------------------------------------------------------------------
-- ROLLBACK / RECOVERY
-- ----------------------------------------------------------------------------
-- Archived rows are PRESERVED in trinity_tasks_history (nothing destroyed) — to restore a row:
--   INSERT INTO public.trinity_tasks SELECT <cols, minus archived_at> FROM trinity_tasks_history WHERE id = $1;
-- CASCADE-deleted children are NOT recoverable (they were removed) — this is why CASCADE children should be
-- reviewed first; if any are audit-bearing, archive them to <child>_history in STEP 2 before deleting parents.
-- To fully abort before any delete: DROP TABLE public.trinity_tasks_history;  (only the empty sink is removed.)

-- ============================================================================
-- CC RECOMMENDATION: Do STEP 0 (VACUUM/repack) first + re-measure — it's reversible and may suffice. Only if the
-- table is still cache-busting do the STEP 1-3 archive, and do it CHUNKED + eyes-on, after sizing each NO ACTION
-- child (STEP 2). The CASCADE children are the only irreversible part — review them before the first delete.
-- ============================================================================
