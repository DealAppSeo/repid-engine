-- Rollback for 2026_09_22_peer_verification_queue_lease_and_closure.sql
--
-- ⚠ NARROWING THE CHECK IS NOT SAFE ON ITS OWN. If any row has already been closed
-- as 'stale' or 'skipped', restoring the original constraint FAILS — the ADD is
-- validated against existing rows. That is the correct behaviour: it refuses rather
-- than silently stranding rows in a status the constraint no longer admits.
--
-- To roll back after rows were closed, first decide what those rows should become
-- (they were closed for a reason, and 'stale' rows are the recursion evidence), then
-- run this. The migration is additive, so leaving it applied is also a valid choice.

BEGIN;

DROP INDEX IF EXISTS public.idx_pvq_expired_lease;

ALTER TABLE public.peer_verification_queue
  DROP CONSTRAINT IF EXISTS peer_verification_queue_verification_status_check;

ALTER TABLE public.peer_verification_queue
  ADD CONSTRAINT peer_verification_queue_verification_status_check
  CHECK (verification_status = ANY (ARRAY[
    'pending'::text, 'in_review'::text, 'verified'::text,
    'disputed'::text, 'timeout'::text
  ]));

ALTER TABLE public.peer_verification_queue DROP COLUMN IF EXISTS closure_reason;
ALTER TABLE public.peer_verification_queue DROP COLUMN IF EXISTS claimed_at;

COMMIT;
