-- SIGNED-JOB RECEIPTS — TrustKeys "reference tier" (Sean, 2026-10-08: "No key on our disk").
--
-- The owner signs a job on their OWN box. The engine verifies the signature and that the job is
-- inside a policy they already signed, then records ONLY these receipt fields. This is NOT custodial
-- and NOT a broker: there is NO key column, NO ciphertext, NO master key, NO decrypt-at-use. We never
-- receive, store, or handle a private key or any decryptable secret.
--
-- WHAT IS (AND IS NOT) STORED. A receipt is the minimum needed to make a verification auditable and
-- replay-proof: the owner wallet (public), the job nonce, the action, the cap, the payee HASH, the
-- chain, and that the signature verified. There is deliberately NO sentence, NO prompt, NO key, and
-- NO RAW PAYEE ADDRESS — only keccak256(lowercased payee), computed on the owner's box and sent as a
-- hash. The server never sees the address it hashes.
--
-- REPLAY GUARD = unique(owner, nonce). The INSERT itself is the replay check: a repeated (owner,
-- nonce) raises 23505, which src/services/signed-job.ts reports as `replay`. Any other write error
-- REFUSES as `not_checked` (503) — a failed write is never treated as a verified job.
--
-- ACCESS. RLS on with no policies, every privilege revoked from anon and authenticated, so only the
-- engine's secret key (service_role, which bypasses RLS) writes here. Nothing in this table is public.
--
-- OPERATOR: this migration ships in the PR but is NOT applied automatically. The route stays flag-
-- gated OFF (SIGNED_JOB_VERIFY_ENABLED) until you apply this AND set the flag, so nothing breaks
-- before the table exists.

create table if not exists public.signed_job_receipts (
  id               uuid        primary key default gen_random_uuid(),
  owner            text        not null,                 -- EVM wallet, lowercased. Public.
  nonce            text        not null,                 -- the job nonce (hex)
  action           text        not null,                 -- e.g. 'spend'
  cap              text        not null,                 -- token smallest-unit, as a string (no precision loss)
  payee_hash       text        not null,                 -- keccak256(lowercased payee) — never the raw address
  chain_id         int         not null,                 -- 84532 (Base Sepolia)
  signature_status text        not null,                 -- 'verified'
  created_at       timestamptz not null default now(),
  unique (owner, nonce)                                   -- the replay guard, enforced at the storage layer
);

alter table public.signed_job_receipts enable row level security;

revoke all on public.signed_job_receipts from anon, authenticated;

comment on table public.signed_job_receipts is
  'TrustKeys reference-tier signed-job receipts. Owner-signed job verified inside an owner-signed '
  'policy, then recorded. No key, no prompt, no sentence, no raw payee address — only the payee hash. '
  'unique(owner, nonce) is the replay guard. Written by src/services/signed-job.ts (service_role only).';
