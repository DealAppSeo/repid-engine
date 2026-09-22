-- peer_verification_queue — a lease for the claim, and a vocabulary for closing a row.
--
-- STATUS: **UNAPPLIED.** Not run against any project. Applying it is a separate,
-- deliberate act; nothing in this repo applies migrations automatically.
--
-- WHY THIS EXISTS
-- ---------------
-- 62,841 rows sit in `in_review` with `verifier_agent_id IS NULL`, frozen since
-- 2026-07-21 [MEASURED 2026-09-22]. They are not a backlog. They are the only
-- possible outcome of the current design the first time a verifier dies mid-run:
--
--   * The claim and the verdict are TWO STEPS. A worker sets `in_review`, then
--     calls an LLM, signs an HMAC, and POSTs the verdict separately. Nothing
--     releases the row if any of that fails.
--   * There is NO `claimed_at` and no `updated_at`, so a stale claim is
--     INDISTINGUISHABLE from a live one. Nothing can reclaim what it cannot date.
--
-- So the wedge is structural, and no amount of reclaiming fixes it — a reclaimed
-- row re-wedges on the next provider hiccup. The column is the fix; the reclaim
-- is a separate, later decision that this migration deliberately does NOT make.
--
-- WHAT THE CHECK CONSTRAINT CHANGE IS FOR — TWO STATUSES THE CODE ALREADY WRITES
-- -----------------------------------------------------------------------------
-- The live constraint admits exactly:
--     pending | in_review | verified | disputed | timeout
--
-- and TWO values the codebase already writes are absent from it:
--
--   'skipped'  `peer-verification-reader.ts` writes this when the prefilter runs in
--              ENFORCE mode. That mode has never been switched on, so the write has
--              never executed. The first operator to set it would take a 23514 on
--              every skip. This is a latent bug found before it fired, not a
--              hypothetical.
--
--   'stale'    the vocabulary for closing the 36,193 recursion rows (claim_text is a
--              previous verdict string) WITHOUT deleting them. They are the evidence
--              that the producer/consumer loop recursed; deleting erases the proof.
--
-- This is the `repid_agents_tier_check` lesson applied one table over: a trigger or
-- writer that produces a string the constraint rejects breaks every write. Change
-- the constraint and the writer together, in one migration, or neither.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
--   * It does not reclaim anything. `claimed_at` is NULL on every pre-existing row,
--     and the reclaim predicate is `claimed_at < now() - TTL`, which NULL never
--     satisfies. The 62,841 legacy rows are therefore INERT under this change by
--     construction, not by policy. That is deliberate: reclaiming them produces no
--     fact-verified row, because the table has no artifact column for evidence to
--     live in and no task reference to recover one from.
--   * It does not close the 36,193. That is a separate data statement, run after
--     this lands, so the schema change can be reviewed on its own.
--   * It does not turn the panel on, touch scoring, or alter any existing row.
--
-- Additive only: two nullable columns, one widened CHECK, one partial index.

BEGIN;

ALTER TABLE public.peer_verification_queue
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN public.peer_verification_queue.claimed_at IS
  'When verification_status last moved to in_review. NULL on rows claimed before '
  '2026-09-22, which is why the TTL reclaim predicate (claimed_at < now() - ttl) '
  'cannot match them. Set by the claimer; cleared when the row reaches a terminal '
  'status. Without this a stale claim is indistinguishable from a live one.';

ALTER TABLE public.peer_verification_queue
  ADD COLUMN IF NOT EXISTS closure_reason text;

COMMENT ON COLUMN public.peer_verification_queue.closure_reason IS
  'Why a row was closed without a verdict. Free text, set alongside a terminal '
  'status. First use: recursive_meta_verification, for rows whose claim_text is '
  'itself a previous verification verdict.';

-- Widen the status vocabulary. Drop-and-recreate because Postgres has no
-- ALTER CONSTRAINT for a CHECK expression.
ALTER TABLE public.peer_verification_queue
  DROP CONSTRAINT IF EXISTS peer_verification_queue_verification_status_check;

ALTER TABLE public.peer_verification_queue
  ADD CONSTRAINT peer_verification_queue_verification_status_check
  CHECK (verification_status = ANY (ARRAY[
    'pending'::text,
    'in_review'::text,
    'verified'::text,
    'disputed'::text,
    'timeout'::text,
    'skipped'::text,   -- written by the prefilter in enforce mode
    'stale'::text      -- closed without a verdict, never deleted
  ]));

-- The reclaim scan: expired leases only. Partial, so it stays small as the table
-- grows and is never consulted for terminal rows.
CREATE INDEX IF NOT EXISTS idx_pvq_expired_lease
  ON public.peer_verification_queue (claimed_at)
  WHERE verification_status = 'in_review' AND verifier_agent_id IS NULL;

COMMIT;
