# INBOX_GA — plugin-ready contracts for DP / secure aggregation / zk disclosure

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is a specification
returned as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA.md \
  --requires reasoning,repo_read
```

---

### Why this task exists

The standing order changed on 2026-08-20. FL / DP / ZKP are **no longer on hold**.
What is held is *overclaiming* — nothing is MEASURED or user-facing until a GateRun
says so. The seams are to be built now, so that surfacing a feature later is
**integration rather than greenfield**.

Your half is the **data contracts**. XC has the policy predicates in parallel; do not
write policy logic, and do not assume what XC will decide.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell` or `hyperdag-protocol`. Everything
below is stated because you cannot go and check it. Do not claim to have read any file
outside this repo, and do not invent its contents.

**The trust vocabulary. Four states, and the distinctions ARE the product:**

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy, not the real quantity. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning and **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

Two outcomes collapse "we did not look" into "it passed". Every status field you design
must be able to express all four. A boolean cannot, so do not design one.

**Exit-code convention** for anything runnable: `0` VERIFIED, `2` NOT_CHECKED, anything
else FAILED.

**Existing shapes in THIS repo you should align to (read them, don't guess):**
- `src/services/principal-grants.ts` — principal→principal grants: scope, budget,
  expiry, revoke.
- `src/services/effective-authority.ts` — `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]`.
  It stamps `rRouteIsLedgerApproximation: true` because this engine **cannot** compute the
  true decay-adjusted `R_route`. That is the house pattern for an honest approximation:
  compute it, label it, never silently upgrade it to MEASURED.
- `src/services/bounty-authorization.ts` and `src/services/stake-authorization.ts` — the
  house authorization pattern: dedicated module, pure decision function returning
  `{ok, reason, detail}`, identity from the credential never the body, fail closed.
- `src/providers/cost-class.ts` — the **three-state** doctrine, and the best example in
  the repo of why `unpriced` must never collapse into `free`. Your DP budget types have
  the same hazard: "no budget recorded" is not "no budget spent".

**Cross-repo facts you cannot verify and must not restate as your own observation:**
- `trinity-ecosystem` holds a capability/caveat/TTL attenuation algebra
  (`capability.ts` wildcard-aware attenuation; `caveat.ts` with `maxValue`,
  `toolAllowlist`, `maxCalls`) and a promotion engine that already emits
  MEASURED / NOT_CHECKED / FAILED / live / soft-live / observe / blocked.
- Grants predicates G1–G8: **G6** (grantor revoke, cascading) is MEASURED end-to-end;
  **G1 and G3** (mint-floor enforcement) are NOT_CHECKED — no measured caller.
- `PAY_AUTH_MODE` is **observe**: the pay gate records what it would decide and does not
  decide it. Do not design anything that assumes enforcement.

---

### Deliverables — three documents, in this order

### 1. `dp-budget.v0` — differential-privacy budget objects

A schema for tracking a privacy budget **without claiming any guarantee**.

Must express:
- Budget identity: who the budget belongs to (principal), and over what window.
- `epsilon` / `delta` as **declared parameters**, explicitly separated from any claim
  that a mechanism achieving them has been implemented. A budget object records
  *intent and accounting*, not a proof.
- Spend accounting: each debit, what mechanism claimed it, and the running remainder.
- A `status` field carrying the four-state vocabulary. `NOT_CHECKED` is the correct and
  expected value today for every real row, because no mechanism is wired.
- The **composition** question stated as an open one: naive sequential composition vs
  advanced/RDP accounting give different remainders, and choosing silently would be a
  fabricated guarantee. Name the choice as a required future decision; do not make it.

**Hard constraint:** nothing in this schema may be named or documented in a way that
implies a DP guarantee currently holds. It does not.

### 2. `secure-aggregation-session.v0` — session shape

The shape of one secure-aggregation round, as a contract only.

Must express: session identity; the cohort (see XC for the *rules* — you define the
*shape*); per-participant state transitions; the minimum-cohort threshold as a field
rather than a constant; dropout handling as an explicit state, not an absence; and what
the coordinator can and cannot see, stated as a property of the shape.

**Hard constraint:** FL opt-in is **default OFF in product config**. Design the shape so
that "no session exists" is the natural resting state and participation is an explicit,
recorded act.

### 3. `zk-selective-disclosure.v0` — disclosure and validation-attestation fields

Fields for a selective-disclosure attestation over reputation.

Must express: what statement is being proven; which attributes are disclosed vs withheld;
the verifier-facing result; and a status that distinguishes "proof verified"
(`MEASURED`) from "no proof presented" (`NOT_CHECKED`) from "proof rejected" (`FAILED`).

**Hard constraint:** this repo's ZKP layer is a **deliberate stub**. Sprint-3 stubs must
not be "fixed" by hardcoding a passing result — that converts an honest absence into a
false measurement, which is worse than the gap. Your contract must make a stubbed prover
*representable* as NOT_CHECKED rather than silently passing.

### 4. Capability-declaration hooks for FL opt-in

How an agent declares FL participation as a capability, consistent with the existing
capability-declaration approach. **Default OFF.** An absent declaration must mean "not
participating", never "participating with defaults".

---

### Acceptance criteria

- Every status field can express all four vocabulary states.
- No field name, comment or example implies a guarantee that is not implemented.
- Each document names its own **open questions** explicitly rather than resolving them
  by assumption. An unresolved question stated plainly is a better deliverable than a
  confident wrong answer.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.

### What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. If you did not run it, you did not run it.
- Filling in a Sprint-3 stub.
- A two-state (boolean) status anywhere.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not
include credentials, project identifiers, row counts or service names in your output.
