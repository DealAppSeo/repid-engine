-- KERNEL RECEIPTS: ENGINE SIGNATURE + ONE WRONG PER CONTENT — review-only DDL (2026-10-14)
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
--   one wrong / content  Two FAILED receipts for the same work (same subject + args_hash) are ONE wrong.
--                     The engine's claim is `UPDATE … SET consumed_at = now() WHERE receipt_id = $1 AND
--                     consumed_at IS NULL`. With this partial unique index a second FAILED claim of the
--                     same content fails with 23505 inside that one statement and is held inert, also
--                     across processes. The settler (services/failed-receipt-settler.ts) additionally
--                     skips such duplicates before calling, so this index is the atomic backstop, and the
--                     VERIFIED gain index (content-claim migration) is unaffected: a wrong after a paid
--                     right of the same content still applies.

BEGIN;

ALTER TABLE public.kernel_receipts ADD COLUMN IF NOT EXISTS engine_signature jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS kernel_receipts_one_wrong_per_content
  ON public.kernel_receipts (subject_agent_id, args_hash)
  WHERE consumed_at IS NOT NULL AND verification_status = 'FAILED';

ROLLBACK;  -- REVIEW-ONLY. Change to COMMIT only on a logged decision.

-- ── POST-APPLY CHECKS (read-only) ─────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'kernel_receipts' AND column_name = 'engine_signature'; -- 1 row, jsonb
-- SELECT indexname FROM pg_indexes WHERE indexname = 'kernel_receipts_one_wrong_per_content';            -- 1 row

-- ── DOWN ──────────────────────────────────────────────────────────────────────────────────────
-- Without the column the indexer's upsert fails and nothing is indexed (fail closed); without the index
-- a duplicate FAILED claim is only stopped by the settler's own skip.
-- DROP INDEX IF EXISTS public.kernel_receipts_one_wrong_per_content;
-- ALTER TABLE public.kernel_receipts DROP COLUMN IF EXISTS engine_signature;
