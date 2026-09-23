-- Rollback for 2026_09_23_peer_verification_queue_reclaim_budget.sql
--
-- Dropping the column REMOVES THE BACKUP BOUND on the reclaim loop. Breaker 2.4
-- (the PEER_VERIFY_PANEL_ENABLED gate in peer-verification-reader.ts) still holds
-- on its own, but only while that flag is false. Do not roll this back and enable
-- the panel in the same window.
drop index if exists public.peer_verification_queue_reclaim_idx;
alter table public.peer_verification_queue drop column if exists reclaim_count;
