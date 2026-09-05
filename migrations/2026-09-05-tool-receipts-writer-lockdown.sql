-- 2026-09-05-tool-receipts-writer-lockdown.sql
-- APPLIED 2026-09-05 (logged here for version control + reproducibility).
--
-- CONTEXT: XC red-teamed trustshell_tool_receipts and forged receipts via DIRECT
-- INSERT (rows with minted_by=null, sig_version=1, some hmac_signature invalid),
-- bypassing write_tool_receipt()'s HMAC signing. CC1 confirmed repid-engine never
-- direct-inserts; cross-repo grep found no legitimate direct-insert caller. So the
-- direct-write grants only enabled forgery.
--
-- FIX: make the SECURITY DEFINER function write_tool_receipt() (runs as owner
-- `postgres`) the ONLY writer. Non-owner roles keep SELECT (receipts are public-
-- readable) but lose all write/truncate, so a receipt cannot be minted, mutated,
-- or wiped except through the signing path. Receipts become append-only + unforgeable.
--
-- The RPC path is unaffected (verified live: a canary mint via the function still
-- succeeds after these revokes). Reversible: re-GRANT if a legitimate direct writer
-- is ever identified.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.trustshell_tool_receipts FROM service_role;
REVOKE TRUNCATE ON public.trustshell_tool_receipts FROM anon, authenticated;

-- End state (verified): anon/authenticated/service_role = SELECT (+REFERENCES,TRIGGER);
-- postgres (owner) = ALL; write_tool_receipt() is the sole writer.

-- rollback:
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.trustshell_tool_receipts TO service_role;
--   GRANT TRUNCATE ON public.trustshell_tool_receipts TO anon, authenticated;
