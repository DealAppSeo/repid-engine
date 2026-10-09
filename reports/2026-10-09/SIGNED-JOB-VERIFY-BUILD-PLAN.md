# TrustKeys "reference tier" — signed-job VERIFIER (PR 1 of N)

**Date:** 2026-10-09 · **Status:** built, flag-gated OFF, paper + testnet only.

## The decision this implements (Sean, 2026-10-08 — "No key on our disk")

The owner's own box holds their key. They sign a job on that box. We VERIFY the
signature AND that the job is inside a policy they already signed. We store ONLY
receipt fields. This is **not a broker and not custodial**: we never receive, store,
or handle a private key or any decryptable secret.

## Hard constraints (honored, do not relax in a follow-up)

- **No custodial store, no decrypt-at-use, no key column, no master key.** The receipt
  table has no key/ciphertext column. `src/services/signed-job.ts` imports nothing from
  `src/services/byok-custody.ts` (PR #1270 — a different, independent custodial approach)
  and never will.
- **No KMS, no ZK circuit, no Laya, no broker in a Witness.** This PR is signature
  verification + a policy-membership check + a receipt. Nothing is compiled or wired in
  beyond that.
- **The receipt stores no sentence, no key, no prompt, no raw payee address** — only a
  payee HASH (`keccak256(lowercased payee)`), which the owner's box computes and sends.
  The server never sees the raw payee address it would hash.
- **Three outcomes, never two.** A refusal is a clean explicit deny. A DB or RepID read
  that ERRORS REFUSES (`not_checked`, 503); the raw error is logged server-side only and
  never returned. "Not checked" is never "passed". No fund movement, no on-chain write,
  no stake — verify only validates and records.

## Pinned schema

**Policy** (owner signs once; addresses + a cap, not secret):

```
{ v:1, type:'trustkeys-policy', owner:<wallet lowercased>, chain_id:84532,
  cap:<int smallest-unit, as string>, token:<symbol>,
  payee_hashes:[<keccak256(lowercased payee)>...], expiry:<unix s>, policy_nonce:<hex> }
```

**Job** (owner signs per action):

```
{ v:1, type:'trustkeys-job', owner:<wallet lowercased>, chain_id:84532,
  action:<string e.g. 'spend'>, cap:<int string>, payee_hash:<hex>,
  expiry:<unix s>, nonce:<hex> }
```

**Receipt** (`supabase/migrations/20261009000000_signed_job_receipts.sql`):

```
signed_job_receipts(
  id uuid primary key default gen_random_uuid(),
  owner text not null,          -- wallet, lowercased. Public.
  nonce text not null,
  action text not null,
  cap text not null,            -- string, so smallest-unit caps lose no precision
  payee_hash text not null,     -- never the raw address
  chain_id int not null,
  signature_status text not null,
  created_at timestamptz not null default now(),
  unique(owner, nonce)          -- the replay guard, at the storage layer
)
```

RLS is on with no policies and anon/authenticated are revoked, so only the engine's
secret key (service_role, which bypasses RLS) writes here. Nothing in the table is public.

## Verify order (`POST /api/v1/jobs/verify`, refuse on first failure)

1. **Flag gate** — `SIGNED_JOB_VERIFY_ENABLED !== 'true'` → **404**, before any DB read
   (inert per CLAUDE_RULES 23).
2. **Signatures** — one deterministic canonicalizer (stable key order, no whitespace) is
   used to recompute the signing string. `policy_signature` must recover `policy.owner`,
   `job_signature` must recover `job.owner`, and `policy.owner === job.owner` — else
   **signature_mismatch** (401). The `type` field is inside the signed bytes, so a policy
   signature cannot be replayed as a job signature. A chain-unreachable smart-wallet check
   is **not_checked** (503), never a mismatch.
3. **Expiry** — both `expiry` in the future, else **expired** (401).
4. **Payee** — `job.payee_hash ∈ policy.payee_hashes`, else **payee_not_allowed** (403).
5. **Cap** — `effective_cap = min(policy.cap, repidCeiling(owner))`; RepID may only
   TIGHTEN (always the min, never above `policy.cap`). `repidCeiling` is derived from the
   owner's agent RepID through the existing ownership read path
   (`human_agent_bindings.human_wallet → repid_agents.current_repid`), mapped by a
   documented monotonic rule: `clamp(current_repid, 10, 10000) * 1_000_000` smallest-units
   (one token unit per RepID point); an owner with no bound agent resolves to the RepID
   floor (the most conservative ceiling). `job.cap <= effective_cap` (compared as BigInt so
   large caps lose no precision), else **cap_exceeded** (403). A RepID read that ERRORS →
   **not_checked** (503).
6. **Replay guard = the receipt insert**, `unique(owner, nonce)`. Duplicate → **replay**
   (409). Any other write error → **not_checked** (503), raw error server-side only.
7. **Success** → **200** `{ verified:true, receipt:{ action, cap, payee_hash, chain_id,
   time, signature_status:'verified' } }`.

Reachability: the route mounts ahead of `authMiddleware` (the owner's signature is the
authorization, like the BYOK/bind routes) and still passes through the global SQL-keyword
body sanitizer — the payload is all-hex plus a token symbol and an action word, so a valid
body is not rejected (covered by a test).

## What is explicitly NOT built here

- No custodial key store, no decrypt-at-use (that is PR #1270's separate approach; not
  touched, not imported).
- No KMS, no ZK circuit, no Laya, no broker compiled into a Witness.
- No client-side signing UX.
- No fund movement, no on-chain transaction, no stake, no mint.

## Follow-up order

1. **This PR** — the signed-job verifier + receipt (here).
2. **A ZK proof that the signature was inside policy** — AFTER this verify works, not
   before. It replaces the server-side membership/cap check with a proof the owner's box
   produces, so the server learns even less.
3. **Client-side signing UX** — a later PR: the owner's box builds and signs the policy
   once and a job per action, and submits `{ policy, policy_signature, job, job_signature }`.

## Operator steps (not done here — left to the operator)

- Apply `supabase/migrations/20261009000000_signed_job_receipts.sql`.
- Set `SIGNED_JOB_VERIFY_ENABLED=true` on the `repid-engine` service.
- The route 404s until both are done, so nothing breaks before the table exists.
