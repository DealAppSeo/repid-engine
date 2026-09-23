-- peer_verification_queue — a budget for the reclaim that #841 shipped unbounded.
--
-- WHY THIS EXISTS
-- ---------------
-- `2026_09_22_peer_verification_queue_lease_and_closure.sql` added `claimed_at` and
-- said, in as many words, that acting on it was a separate decision it was not
-- making:
--
--   "a reclaimed row re-wedges on the next provider hiccup. The column is the fix;
--    the reclaim is a separate, later decision that this migration deliberately
--    does NOT make."
--
-- #841 shipped the column and the reclaim in one change. The loop started the next
-- morning [MEASURED 2026-09-23]:
--
--   7 queue rows  ->  339 peer_verify tasks in 8 hours
--   7 rows x 2 reclaims/hr (30m TTL) x 3 panel members = 42 tasks/hr
--
-- 42/hr is the plateau the fleet actually ran at, to the task. The producer was
-- halted with PRODUCER_HALT_CLASSES and the 113 orphans cancelled; this is the part
-- that stops it recurring.
--
-- The real fix is breaker 2.4 in peer-verification-reader.ts: do not reclaim a
-- lease while PEER_VERIFY_PANEL_ENABLED is false, because the panel is what posts
-- the verdict that clears it. Across all 140,194 rows this table has ever held,
-- `verifier_agent_id` is non-null on ZERO — no verdict has ever landed, so every
-- claim ever made was already certain to expire.
--
-- THIS COLUMN IS THE BACKUP, and it is deliberately a second mechanism rather than
-- a tidier version of the first. Breaker 2.4 depends on one env var being false. If
-- someone enables the panel before the verdict path is proven, the gate opens and
-- the loop is unbounded again. A budget makes that worst case finite: past
-- PEER_VERIFY_RECLAIM_CAP (default 3) the row stops being eligible.
--
-- SAFE ON EVERY EXISTING ROW. The default is 0, so the 26,648 legacy rows are
-- unaffected — they remain protected by their NULL `claimed_at`, which no
-- `< staleBefore` predicate can ever match. This adds a second bound to rows the
-- reader touches from now on; it does not reopen anything.

alter table public.peer_verification_queue
  add column if not exists reclaim_count integer not null default 0;

comment on column public.peer_verification_queue.reclaim_count is
  'Number of times an expired lease on this row has been reclaimed. Bounds the reclaim loop: past PEER_VERIFY_RECLAIM_CAP the row is no longer eligible. A first claim does not charge it.';

-- The reader filters on (verification_status, verifier_agent_id, claimed_at,
-- reclaim_count). Index the reclaim predicate alongside the lease so the added
-- column does not turn the poll into a scan.
create index if not exists peer_verification_queue_reclaim_idx
  on public.peer_verification_queue (verification_status, claimed_at, reclaim_count)
  where verifier_agent_id is null;
