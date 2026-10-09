-- SIGNED POLICIES — TrustKeys "reference tier" policy lifecycle (registry + revocation).
-- Stacks on 20261009000000_signed_job_receipts.sql (PR #1273). Same decision (Sean, 2026-10-08:
-- "No key on our disk") and same posture: NOT custodial, NOT a broker. A policy is
-- addresses-as-hashes + a cap + a signature — there is NO key column, NO ciphertext, NO master key,
-- NO decrypt-at-use. We never receive, store, or handle a private key or any decryptable secret.
--
-- WHAT IS STORED. The owner signs a policy on their OWN box; we verify the signature and record the
-- policy so later jobs can be checked against it, and so it can be REVOKED. policy_hash is the
-- content address = keccak256 of the canonical JSON the owner signed (src/services/signed-policy.ts
-- computePolicyHash), which is why it is the primary key: the same policy registers once. policy_json
-- holds payee HASHES and a cap, never a raw payee address and never a secret.
--
-- REVOCATION + REPLAY GUARD. revoked_at marks a policy dead. revocation_nonce records the nonce of
-- the revocation that killed it, with a UNIQUE(owner, revocation_nonce) index as the replay guard:
-- an owner cannot reuse a revocation nonce across policies (a captured revocation is bound to one
-- policy_hash in its signed bytes, so cross-policy reuse requires the owner to double-sign — the
-- index refuses it). NULL revocation_nonce rows (un-revoked policies) are distinct in Postgres, so
-- the index constrains nothing until a revocation stamps a value. This is the only addition beyond
-- the registry columns, and it is here so a revoke is a single atomic UPDATE rather than two writes.
-- Same reasoning as 20261009000000's unique(owner, nonce): the storage layer is where a replay guard
-- cannot be forgotten.
--
-- ACCESS. RLS on with no policies, every privilege revoked from anon and authenticated, so only the
-- engine's secret key (service_role, which bypasses RLS) reads or writes here. The public GET route
-- is served by the engine with that key and returns only non-secret fields — nothing in this table is
-- directly reachable by a browser caller.
--
-- OPERATOR: this migration ships in the PR but is NOT applied automatically. The routes stay flag-
-- gated OFF (SIGNED_JOB_VERIFY_ENABLED, shared with #1273) until you apply this AND set the flag, so
-- nothing breaks before the table exists.

create table if not exists public.signed_policies (
  policy_hash       text        primary key,              -- keccak256(canonical policy) — content address
  owner             text        not null,                 -- EVM wallet, lowercased. Public.
  policy_json       jsonb       not null,                 -- the signed policy (payee HASHES + cap), no secret
  signature         text        not null,                 -- the owner's signature over the canonical policy
  chain_id          int         not null,                 -- 84532 (Base Sepolia)
  expiry            bigint      not null,                  -- unix seconds; policy is not "active" past it
  revoked_at        timestamptz,                           -- set once, by a valid owner revocation
  revocation_nonce  text,                                  -- nonce of the killing revocation; replay guard below
  created_at        timestamptz not null default now()
);

-- Active-policy lookup: most recent for an owner (src/services/signed-policy.ts verifyJobWithStoredPolicy).
create index if not exists signed_policies_owner_created_idx
  on public.signed_policies (owner, created_at desc);

-- Replay guard: a revocation nonce may be used at most once per owner. NULLs (un-revoked) are distinct.
create unique index if not exists signed_policies_owner_revocation_nonce_key
  on public.signed_policies (owner, revocation_nonce);

alter table public.signed_policies enable row level security;

revoke all on public.signed_policies from anon, authenticated;

comment on table public.signed_policies is
  'TrustKeys reference-tier signed policies: an owner-signed policy registered once (policy_hash = '
  'keccak256 of the canonical policy) and revocable via revoked_at. No key, no ciphertext, no raw '
  'payee address — payee HASHES and a cap only. unique(owner, revocation_nonce) is the revoke replay '
  'guard. Written/read by src/services/signed-policy.ts + src/routes/v1/policies.ts (service_role only).';
