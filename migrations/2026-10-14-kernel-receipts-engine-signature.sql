-- KERNEL RECEIPTS: ENGINE SIGNATURE (no wrong-per-content index) — review-only DDL (2026-10-14)
--
-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED. REVIEW-ONLY. Sean applies prod DDL; no agent lane does.                         ║
-- ║  Ends in ROLLBACK, so running it as written changes nothing. Apply AFTER                     ║
-- ║  supabase/migrations/20261013000000_kernel_receipts.sql and                                  ║
-- ║  migrations/2026-10-14-kernel-receipts-content-claim.sql. Arms nothing:                      ║
-- ║  CONFIRMED_OUTCOME_SCORING_ENABLED stays OFF and is the only thing that reads these.          ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY (XC1's review of #1371).
--   engine_signature  RLS does not stop forgery: the service role is the indexer's own key and it
--                     bypasses RLS, so a service-role writer could insert a self-consistent re-sealed
--                     receipt (receipt_hash is an unsigned keccak). The indexer now signs each receipt at
--                     seal time with the engine's receipt-only key (RECEIPT_SIGNING_KEY, the #1333
--                     signer) and stores the DETACHED signature here; the verifier
--                     (kernel/receipt-db-index.ts::gateReceiptProblem) requires it to verify against the
--                     engine signer. The receipt JSON itself is unchanged (kernel-receipt/1 pins
--                     header.signer null). Until this column exists the indexer's upsert is rejected
--                     (unknown column), nothing is indexed and nothing confirms: fail closed.
--
-- NO WRONG-PER-CONTENT INDEX (XC1's review of #1374). An earlier draft of this file created
--   kernel_receipts_one_wrong_per_content (subject_agent_id, args_hash) WHERE consumed_at IS NOT NULL
--   AND verification_status = 'FAILED'. Postgres cannot check a secp256k1 signature, so that index
--   counted ANY consumed FAILED row, signed or not: one service-role decoy with the victim's args_hash
--   made every later real, signed wrong fail its claim with 23505, forever. Scoping it to
--   `engine_signature IS NOT NULL` does not help (a garbage signature is not null). And args_hash is
--   client-chosen, so "one wrong per content" never meant one wrong per piece of work. A FAILED receipt
--   is spent once by its receipt_id (the claim's own WHERE consumed_at IS NULL), as the content-claim
--   migration says, and that is the only key. The DROP INDEX below removes the index if the earlier
--   draft was ever applied; otherwise it is a no-op.

BEGIN;

ALTER TABLE public.kernel_receipts ADD COLUMN IF NOT EXISTS engine_signature jsonb;

DROP INDEX IF EXISTS public.kernel_receipts_one_wrong_per_content;

ROLLBACK;  -- REVIEW-ONLY. Change to COMMIT only on a logged decision.

-- ── POST-APPLY CHECKS (read-only) ─────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'kernel_receipts' AND column_name = 'engine_signature'; -- 1 row, jsonb
-- SELECT indexname FROM pg_indexes WHERE indexname = 'kernel_receipts_one_wrong_per_content';            -- 0 rows

-- ── DOWN ──────────────────────────────────────────────────────────────────────────────────────
-- Without the column the indexer's upsert fails and nothing is indexed (fail closed).
-- ALTER TABLE public.kernel_receipts DROP COLUMN IF EXISTS engine_signature;
