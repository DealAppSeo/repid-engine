-- SIGNED-JOB RECEIPT ENGINE ATTESTATION — TrustKeys "reference tier" (stacks on
-- 20261009000000_signed_job_receipts.sql).
--
-- WHAT THIS ADDS. Two nullable columns so a receipt can carry the ENGINE's own attestation of a
-- verified job: a signature the engine produced with its attestation key, and the engine signer
-- address that signature recovers to. With both present, anyone can recover the signer from the
-- receipt bytes + signature and confirm it equals the engine's published signer — proving the engine
-- attested a verified job WITHOUT trusting a database read. Written by src/services/signed-job.ts via
-- src/services/receipt-attestation.ts.
--
-- THE ENGINE'S KEY, NOT A USER/CUSTODY KEY. The signature comes from RECEIPT_SIGNING_KEY, an engine
-- attestation EOA key like the EAS / BASE_SEPOLIA attestor keys this system already uses. It is NOT a
-- BYOK/user key and NOT a decryptable secret — "no key on our disk" is about user secrets, untouched
-- here. Neither column is secret: a signature and a public address reveal nothing about the key.
--
-- NULLABLE ON PURPOSE (THREE OUTCOMES, NEVER TWO). When RECEIPT_SIGNING_KEY is unset the feature is
-- inert: receipts are written with these columns NULL and reported `attested:false` — which is "not
-- attested", never "attestation failed" and never "attested". Existing receipts predating this
-- migration keep NULL and read exactly the same way, so there is nothing to backfill.
--
-- ACCESS is inherited from the base table: RLS on with no policies, every privilege revoked from anon
-- and authenticated, so only the engine's secret key (service_role, which bypasses RLS) writes here.
--
-- OPERATOR: this migration ships in the PR but is NOT applied automatically. The routes stay flag-
-- gated OFF (SIGNED_JOB_VERIFY_ENABLED), and the attestation stays inert until RECEIPT_SIGNING_KEY is
-- set, so nothing changes before you apply this AND configure both.

alter table public.signed_job_receipts
  add column if not exists receipt_signature text,   -- engine EIP-191 signature over the receipt bytes (public)
  add column if not exists receipt_signer    text;   -- the engine signer address that signature recovers to (public)

comment on column public.signed_job_receipts.receipt_signature is
  'Engine attestation: EIP-191 personal_sign over canonicalJson({v:1,type:trustkeys-receipt,owner,nonce,'
  'action,cap,payee_hash,chain_id,time}), produced with RECEIPT_SIGNING_KEY. NULL when the engine '
  'attestation key is unset (receipt is then attested:false). Public — reveals nothing about the key.';

comment on column public.signed_job_receipts.receipt_signer is
  'Engine attestation signer: the public address RECEIPT_SIGNING_KEY resolves to, which receipt_signature '
  'recovers to. NULL when the key is unset. Public; compare against GET /api/v1/receipts/signer.';
