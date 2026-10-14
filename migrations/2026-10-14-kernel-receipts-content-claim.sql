-- KERNEL RECEIPTS: ONE CONFIRMED GAIN PER (SUBJECT, CONTENT) — review-only DDL (2026-10-14)
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED. REVIEW-ONLY. Claude / Sean apply prod DDL; no agent lane does.         ║
-- ║  Apply AFTER supabase/migrations/20261013000000_kernel_receipts.sql (also unapplied: ║
-- ║  public.kernel_receipts did not exist in prod on 2026-10-14). Arms nothing: the      ║
-- ║  CONFIRMED_OUTCOME_SCORING_ENABLED flag stays OFF and is the only thing that reads it. ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY (XC1 red-team, finding 1, S1). The confirmed-outcome claim keyed only on receipt_id, and the
-- kernel mints a fresh receipt_id for every call. So the same work, re-run, was a fresh full gain.
-- The content key is the receipt's own request.args_hash (keccak256 of the canonical arguments).
--
-- WHAT.
--   args_hash   written by src/kernel/receipt-db-index.ts from receipt.request.args_hash, and read by
--               src/engine/repid-update.ts::resolveServerConfirmation, which FAILS CLOSED on a row
--               without one (and on a table without the column: the select errors).
--   index       a PARTIAL UNIQUE index over the rows that have been SPENT AS A GAIN. The engine's claim
--               is `UPDATE kernel_receipts SET consumed_at = now() WHERE receipt_id = $1 AND
--               consumed_at IS NULL` (claimConfirmationReceipt). If that subject's same args_hash was
--               already paid as a gain, the update would put a second row into this index, Postgres
--               refuses it with 23505 inside the one statement, and the engine holds the score inert.
--               Atomic under concurrency; no read-then-write window.
--   FAILED rows are deliberately OUTSIDE the predicate: each failed run is its own confirmed wrong,
--   spent once by receipt_id. A wrong after a paid right of the same content still applies.
--
-- KNOWN LIMIT. args_hash covers the arguments, so salting them (a nonce field) yields a new hash. The
-- per-UTC-day small-gain cap (src/scoring/small-gain-cap.ts, now on the score path) is what bounds that.

alter table public.kernel_receipts add column if not exists args_hash text;

create unique index if not exists kernel_receipts_one_gain_per_content
  on public.kernel_receipts (subject_agent_id, args_hash)
  where consumed_at is not null and verification_status = 'VERIFIED';

-- ── ROLLBACK (DOWN) ─────────────────────────────────────────────────────────────────────────────
-- With this rolled back, resolveServerConfirmation's select names a missing column and every
-- confirmation fails closed (no score moves) — the safe direction.
-- drop index if exists public.kernel_receipts_one_gain_per_content;
-- alter table public.kernel_receipts drop column if exists args_hash;
