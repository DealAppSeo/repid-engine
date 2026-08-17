# Shadow-Reject Capability Filter (S-HARDEN Phase 4)

> ## ⚠ CORRECTED 2026-08-17 — THIS IS BUILT, NOT A DESIGN
>
> The title and status line below read **"design, not applied"** and **"DESIGN ONLY"**.
> That is **false** and has been for some time.
>
> The filter is implemented and shipped **default-off** at
> `trinity-symphony-shared/lib/ConstitutionalAgentV4.js:1834-1838` — `CAPABILITY_FILTER`,
> `AGENT_TASK_TYPES`, and the `capFilter` parameter threaded into the pending-task query
> exactly as the design below specifies. The off-state is pinned by a test at
> `trinity-symphony-shared/tests/claimCallSite.test.js:150`.
>
> **What is still true:** the *verification plan* at the bottom of this document has never
> been run. Nobody has enabled it for a canary agent, and nobody has measured whether the
> churn actually stops. So the mechanism is in **shadow** — built, gated off, unmeasured —
> which is a materially different state from "designed".
>
> **Why this matters beyond one stale heading.** This document was read as evidence that the
> fix did not exist, and that reading was carried into `docs/RSI-ADOPTION-PLAN.md` and had to
> be corrected there too. A doc that understates what is built causes work to be re-planned,
> not merely mis-described. Verified by grepping for the symbol rather than reading the prose
> about it (LESSONS §2).
>
> Standing state now lives in `src/orchestration/promotion-register.ts`, which is checked by
> tests; this document is the design and the verification plan.

**Repo of the fix:** trinity-symphony-shared (`lib/ConstitutionalAgentV4.js` `getNextTask`). **Original status line, retained for the record:** DESIGN ONLY — that claim loop is being rewritten on GA's in-flight `feat/ga-2026-05-30-t12-concurrency`, so per the deconfliction rule this is **not** edited here; fold it into T12 or apply after T12 merges. *(That deconfliction has since resolved and the change landed; see the correction above.)*

## Root cause `[sql:2026-06-02]`
Agents claim task types they have **no handler for**, then `shadow_reject` them — wasted claim/release cycles. shadow_reject by type (last 24h):

| task_type | shadow_rejects (24h) | agents | agent has a handler? |
|---|---|---|---|
| **cait** | **276** | 9 | ❌ no handler |
| **EVERGREEN** | **256** | 9 | ❌ no handler |
| review | 94 | 9 | ✅ (these are *content* rejects — legit, a verifier rejecting bad content) |
| system | 7 | 5 | ✅ (local handler) |

`cait` + `EVERGREEN` = **532 of ~633 (≈84%)** of shadow_rejects, and they're pure capability mismatches (no agent can process them). The `review` rejects are legitimate verification outcomes, not capability gaps.

## Capability matrix (all 12 agents run the same `ConstitutionalAgentV4`)
Handled types (from `lib/ConstitutionalAgentV4.js`): `peer_verify` (`:1157/:1548`), `review` + `meta` (`:1949`), and the local types `system`/`self-healing`/`heartbeat`/`wake` (+ `[HEALING]`/`[HEARTBEAT]`/`[SYSTEM]` titles). **Not handled: `cait`, `EVERGREEN`.** Because all 12 agents share the code, the capability set is uniform — one whitelist suffices (no per-agent matrix needed).

## Fix (flag-gated, simplest = env whitelist)
In `getNextTask`, add a capability predicate gated by `CAPABILITY_FILTER=true` (default off → today's behavior):
```js
const CAPABILITY_FILTER = process.env.CAPABILITY_FILTER === 'true';
const HANDLED = (process.env.AGENT_TASK_TYPES ||
  'peer_verify,review,meta,system,self-healing,heartbeat,wake').split(',').map(s => s.trim());
// ...in the pending query, when CAPABILITY_FILTER:
//   supabase: .in('task_type', HANDLED)
//   direct-pg: AND task_type = ANY($handled)
```
Default-off = byte-identical to today. With it on, agents stop claiming `cait`/`EVERGREEN`.

## Expected effect
- **shadow_reject drops ≈84%** (the cait+EVERGREEN churn stops); agents spend cycles only on work they can complete.
- `cait`/`EVERGREEN` tasks become **pending-unclaimed** (not churned) → surfaces the real issue: a **producer** is creating task types no agent handles (same class of bug as the `VERIFIER_POOL` 3-of-12 producer issue). Follow-up: either add `cait`/`EVERGREEN` handlers or stop the producer from emitting them.
- **No starvation:** the whitelist still includes `peer_verify` (the bulk of real work), so agents keep claiming.

## Verification plan (once applied to one agent)
1. Enable `CAPABILITY_FILTER=true` for a single canary agent.
2. Confirm its shadow_reject count for cait/EVERGREEN → 0 over the next window.
3. Confirm it still claims peer_verify (no starvation).
4. Roll out to the fleet; track total shadow_reject before/after.
