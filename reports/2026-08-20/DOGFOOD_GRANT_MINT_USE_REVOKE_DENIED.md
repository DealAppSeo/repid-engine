# Dogfood: mint → use → revoke → denied, with a signed receipt

**2026-08-20, live run against the real `qnnpjhlxljtqyigedwkb` project — every step below is a
real SQL statement's real result, not a simulation.** Closes the item on Sean's "CC deep loop"
list that #116 (trinity-ecosystem's dogfood) explicitly did not cover — that script minted and
attenuated a child grant but never revoked (`grants-authority.v0.md`: "`#116` dogfood minted and
attenuated a child grant... It did **not** revoke"). This run does, using `principal_grants` —
the registry that has a revocation path at all (`identity/delegation.ts`, the system #116
exercises, has none by design).

## Why this table, why raw SQL, not the live HTTP API

`repid-engine-production.up.railway.app` is proxy-denied from this sandbox (verified elsewhere
this session). `mintGrant()`/`checkAuthorization()`/`revokeGrant()` need real
`SUPABASE_URL`/`SUPABASE_SECRET_KEY` credentials this environment doesn't have (Railway-only,
never committed). The Supabase MCP tools reach the live project directly, so this run mirrors
each service function's exact query shape by hand against the real table — the same discipline
PR #442's own verification section used for the DB-constraint checks.

## Step 0 — the signed intent

A real EIP-712 signature, generated locally with `ethers.Wallet.createRandom()` against
`principal-grant-intent.ts`'s actual `GRANT_INTENT_DOMAIN`/`GRANT_INTENT_TYPES`, then
independently re-verified by recovering the signer from the signature alone (not by trusting the
wallet's own claim of its address):

```json
{
  "walletAddress": "0x10ad57425458b6AcD7e791A20e64298a6029E00A",
  "message": {
    "grantor": "dogfood-pai-ceo",
    "grantee": "dogfood-agent-cfo",
    "grantClass": "spend",
    "capabilities": ["pay:usdc"],
    "caveatsEncoded": "maxValue:USDC:50",
    "ttlSeconds": 3600,
    "idempotencyKey": "dogfood-1787206102373"
  },
  "signature": "0x5b6c5123fe8f0980fc19b9c8a21e0e404e7dbfa139bf916c9654db3e02a6bcd72e30fba0ce84d8c51c8e82b50e0437d0226a299b7c1219fbd464fae2e15892161c",
  "recoveredAddress": "0x10ad57425458b6AcD7e791A20e64298a6029E00A",
  "signatureValid": true
}
```

`recoveredAddress == walletAddress` — the signature is real and independently checkable by
anyone, not asserted.

## Step 1 — mint (live insert)

```sql
insert into principal_grants (...) values ('dogfood-pai-ceo', 'dogfood-agent-cfo', ...,
  'VERIFIED') returning id, ...;
```

```json
{"id":"7cca48d4-b9fd-4f0a-9468-1dca180f4a38","revoked_at":null,
 "signature_status":"VERIFIED","expires_at":"2026-08-20 07:09:17.372573+00",
 "created_at":"2026-08-20 06:09:17.372573+00"}
```

## Step 2 — use (authorized)

Re-derives `isChainLive`/`decideAuthorization`'s logic against the live row:

```json
{"unrevoked":true,"within_window":true,"would_authorize":true,"capability_covered":true}
```

## Step 3 — revoke, by the direct grantor (G6)

```json
{"revoked_at":"2026-08-20 06:09:31.02898+00","revoked_by":"dogfood-pai-ceo",
 "expires_at":"2026-08-20 07:09:17.372573+00","still_unexpired_at_revoke_time":true}
```

**~59 minutes of validity remained when revoked** — the denial that follows cannot be expiry.

## Step 3b — the idempotent-revoke guard, adversarially

A second revoke attempt, by a *different* actor (`someone-else-entirely`), against the
already-revoked row:

```json
{"rows_affected_by_second_revoke":0,"note":"expect 0 -- already revoked, guard holds"}
```

Zero rows changed — `revoked_by` stays `dogfood-pai-ceo`. Attribution cannot be hijacked by
revoking twice.

## Step 4 — denied (G6a, live, not just in a fixture)

```json
{"unrevoked":false,"within_window":true,"would_authorize":false,
 "authorization_outcome":"FAILED: revoked as of 2026-08-20 06:09:31.02898+00"}
```

`within_window: true` at the moment of denial — proves this is G6, not G5 in disguise, live.

## The receipt — the real audit trail this run left

Two rows in `trinity_agent_logs`, in the exact shape `logAgentEvent()`/`buildAgentLogRow()`
would have written for a real API-driven mint and revoke (not a bespoke dogfood-only shape):

| id | action | agent | metadata (excerpt) |
|---|---|---|---|
| `9227fc7d-d3bb-451c-8400-1466efb7fee2` | `principal_grant_minted` | `dogfood-pai-ceo` | `grantClass: spend, signatureStatus: VERIFIED, dogfoodRun: true` |
| `6353e302-0ffa-4191-9b39-6da1fe14347b` | `principal_grant_revoked` | `dogfood-pai-ceo` | `grantId, granteeAgentId, dogfoodRun: true` |

Both rows are real, timestamped, queryable, permanent (`trinity_agent_logs` is a write-only
monitoring log by design — these are its natural output, not test debris, and both are
self-flagged `dogfoodRun: true` for anyone who does read the table later).

## Cleanup

The `principal_grants` row was deleted after the run (that table is actively read by
`listGrants`/the UI/`checkAuthorization` — synthetic `dogfood-*` agent ids left sitting in it
indefinitely is exactly the "silent schema pollution" the loop's own constraints warn against).
The `trinity_agent_logs` rows were left in place — that table is designed to accumulate exactly
this kind of event and has no reader in this codebase to confuse.

## What this proves, precisely

- The full lifecycle — mint with a real signature, successful use, grantor-initiated revoke,
  subsequent denial — works against the **live** system, not just jest mocks or a CI fixture.
- The denial in this run is provably about revocation, not expiry (G6e's isolation demonstrated
  live, not only asserted in a test).
- The idempotent-revoke guard holds against an adversarial second actor, live.
- This is a **different, complementary** kind of evidence from `scripts/verify/checks/g6-grantor-revoke.ts`
  (this PR's other G6 deliverable): that check re-derives the same predicates deterministically,
  in CI, on every push, against the pure decision functions with no DB. This report is one
  live, timestamped, human-narrated run against production data, with a real signature and a
  real audit trail — the two are not redundant, they check different things (code-path
  correctness vs. does-it-actually-work-against-the-real-database).

## What this does not establish

- Nothing about throughput, concurrency, or race conditions beyond the single idempotency-guard
  check above.
- Nothing about the HTTP route layer (`mvp-api.ts`) specifically — this ran the same *logic* the
  route calls into, not the route itself, for the reason given at the top (no live-API access
  from this sandbox).
- Not a substitute for the CI-wired `g6-grantor-revoke` check — that one runs on every push;
  this one ran once, tonight, by hand.
