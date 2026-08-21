# INBOX_XC — policy predicates and GateRun hooks for DP / aggregation / zk disclosure

**Lane:** L6 RED-TEAM — **no write scope.** Your deliverable is a specification returned
as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent xc --inbox docs/dispatch/INBOX_XC.md \
  --requires reasoning,repo_read
```

---

## Why this task exists

The standing order changed on 2026-08-20. FL / DP / ZKP are **no longer on hold**. What
is held is *overclaiming* — nothing is MEASURED or user-facing until a GateRun says so.
The seams get built now so that surfacing a feature later is **integration, not
greenfield**.

Your half is the **policy**: predicates, gates, and the ladders that decide when a
control relaxes. GA has the data contracts in parallel. Do not design schemas, and do
not assume what GA will choose — write your predicates against the *properties* you
need, and name the fields you require as requirements on GA.

---

## Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace only** —
you cannot open `trinity-ecosystem`, `trustshell` or `hyperdag-protocol`. Everything
below is stated because you cannot go and check it. Do not claim to have read a file
outside this repo, and do not invent its contents.

**The trust vocabulary — four states, and the distinctions ARE the product:**

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning, **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED. A gate that goes red
for environmental reasons gets ignored within a week, at which point it is worse than no
gate — so distinguish "could not look" from "looked and failed" in every predicate you
write.

**Canonical facts (do not re-derive, do not contradict):**
- Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 · `ESTABLISHED` 1000–4999 ·
  `AUTONOMOUS` 5000–7999 · `VETERAN` 8000–10000. RepID clamps to [10, 10000].
- `tier` is **database-derived** — a Postgres trigger overwrites it from
  `current_repid` on every write. Never design a policy that writes tier directly.
- `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]`. This engine cannot compute the
  true decay-adjusted `R_route` and stamps `rRouteIsLedgerApproximation: true`. Where a
  policy consumes `A_eff` it consumes an **APPROXIMATE** value and must say so — and note
  that latent decay means it can **overstate** authority.
- Grants G1–G8: **G6** (grantor revoke, cascading) is MEASURED end-to-end, in CI and
  against production. **G1 and G3** (mint-floor enforcement) are NOT_CHECKED — no
  measured caller exists.
- `PAY_AUTH_MODE` is **observe**: the ControlProof gate records what it would decide and
  does not decide it. Flipping it is a real decision, not a config tweak. Design for
  observe first; state explicitly what would have to be true to enforce.
- `CONSTITUTIONAL_AUDIT_ENABLED` defaults **FALSE** and the layer is **non-load-bearing**:
  while disabled its output influences no RepID delta, no verdict, no tool gate. A stub
  that always passes must never steer scoring or be reported as a measurement.

**Existing patterns in THIS repo to align with (read them):**
- `src/services/bounty-authorization.ts` — the house authorization pattern, and the
  clearest worked example of a fix that *looks* correct and closes nothing: requiring the
  `admin` scope would have authorised everyone, because public registration grants
  `admin` to every new agent. Read its header before designing any gate.
- `src/providers/cost-class.ts` — three states, never two, and why `unpriced` must not
  collapse into `free`.
- `src/services/effective-authority.ts` — how an honest approximation is labelled.

---

## Deliverables — four specifications

### 1. DP spend predicates + GateRun hooks

Predicates over a DP budget (GA is defining the object; state the fields you need).

Must cover: whether a spend is permitted; what happens when accounting is **absent**
rather than exhausted — these are different and must not share a branch; and the
GateRun outcome mapping to MEASURED / NOT_CHECKED / FAILED.

**The trap to avoid explicitly:** a budget check gated on a value that does not exist
yet reads as the empty string / zero / undefined, and **fails OPEN**. This repo has been
bitten by exactly this shape. Your predicate must fail **closed** on absent accounting,
and you should say so in the spec rather than leaving it implied.

### 2. Aggregation cohort rules

When may a secure-aggregation cohort form, and who may join.

Must cover: minimum cohort size as a **policy input**, not a magic number; eligibility
tied to RepID tier and/or grants; what happens on dropout below threshold; and how a
cohort that cannot form reports — `NOT_CHECKED` (never assembled) is not `FAILED`
(assembled and rejected).

**Hard constraint:** FL participation is **opt-in, default OFF**. No rule may cause an
agent to join a cohort it did not explicitly opt into.

### 3. zk reputation-disclosure policy

When a selective-disclosure proof is required, accepted, or insufficient.

Must cover: which claims require a proof at all; verifier-side acceptance criteria; and
the distinction between *no proof presented* (`NOT_CHECKED`) and *proof rejected*
(`FAILED`). The ZKP layer here is a **deliberate stub** — your policy must treat a
stubbed prover as NOT_CHECKED and must never let it satisfy a requirement.

### 4. HITL relaxation ladders, tied to grants and RepID tier

The highest-value piece, and the one most likely to be got wrong.

Design the ladder by which human-in-the-loop review **relaxes as trust is earned**:
which tier or grant state unlocks which reduction in review, what evidence is required
at each rung, and — most importantly — **what pushes an agent back down**. A ladder with
no descent is not a trust system, it is a ratchet.

Constraints: `REPID_HITL_GATE = 70` and `CONFIDENCE_GATE = 0.8` are canonical. A rung may
never be unlocked by a value that is `APPROXIMATE` without that being stated at the rung.
Since `A_eff` is approximate and can overstate, say what that means for any rung that
consumes it.

### 5. Cross-family critique requirements

What it means for a claim to have been critiqued by a **different model family**, and
when that is required. State the requirement in terms of observable properties, not
vendor names — vendors change, the property is what matters.

---

## Acceptance criteria

- Every predicate distinguishes all four vocabulary states, and says which of them is
  the **fail-closed default**.
- Every gate states its rollback: what single change reverts it.
- Each spec names the specific way it could **fail open**, and how it prevents that. A
  spec that cannot describe its own failure mode has not been thought through.
- Where you are uncertain, write **UNVERIFIED** and say what evidence would settle it.

## What will be rejected

- Any claim you read a file outside this workspace.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. If you did not run it, you did not run it.
- Filling in a Sprint-3 stub, or proposing that ANFIS/LASSO move beyond
  observe/policy. Those stay observe-only.
- Upgrading anything from APPROXIMATE to MEASURED without a named check that produces it.
- Any recommendation to enable FL by default, claim a DP guarantee, or ship zk product UI.

## Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. No
credentials, project identifiers, row counts or service names in your output.
