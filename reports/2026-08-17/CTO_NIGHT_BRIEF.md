# CTO night brief — 2026-08-17

Orchestration session. Surface: cloud CC, GH push = yes, Supabase = yes, Railway = no.
Mode: BUILD. Everything below is dated and was measured, or is marked NOT CHECKED.

---

## 0. Content changes deliberately SKIPPED (Sean's instruction, logged for the record)

Sean's instruction tonight: *"Please do NOT change any surface content. The text is always
the easy and fast part, then we fix the code and we have to change the text back, much
wasted effort."*

Every lane brief carries an explicit prohibition on editing user-facing text. What that
means we did **not** do, from the plan Sean supplied:

| Item in the plan | Status | Why skipped |
|---|---|---|
| Lane 6 — align NORTH-STAR / README / vision-goals to runtime | **SKIPPED** | Pure documentation-surface work |
| Lane 6 — publish the one-page "what works with zero keys" install story | **SKIPPED** | Marketing/docs surface |
| Lane 6 — MEASURED / GATED / TUNABLE / DARK map as a published doc | **PARTIAL, as evidence only** | The measurements were taken (§2–§5) and recorded here, in a report file, not on any published surface |
| Lane 1 — "x402: keyless list OR docs that never claim keyless" | **CODE half only** | The docs half is text |
| Lane 1 — ReputationRegistry ABI documentation | **SKIPPED** | Documentation |
| Terms LIVE / PARTIAL / TARGET labelling across surfaces | **SKIPPED** | Text |

Nothing above is lost — it is deferred until the code beneath it stops moving, which is
exactly the sequencing Sean asked for.

**One text-adjacent exception was taken deliberately:** code comments and this report.
Comments are part of the code and this repo's convention is that a comment names the
incident that earned the rule. No published or user-facing surface was touched.

---

## 1. Fleet liveness — three surfaces disagreed, and two were wrong

The one frozen column at the root of it: agent-side heartbeat writes were deliberately
disabled on **2026-07-17 22:18** to shed ~8.6M writes/day. Two separate heartbeat tables
have been frozen at that instant ever since. Neither was retired, and three surfaces still
read them.

| Surface | What it said | Truth |
|---|---|---|
| `trinity_heartbeat.last_seen` | all 12 agents last seen 2026-07-17 | frozen by design, not a signal |
| `survivor_alert` (reads the above) | "trinity-torch is DOWN, Time Down: 43,962 minutes" | **false alarm**, ~154 in 3h |
| `v_fleet_truth.liveness_signal` | 3 agents `'work'` | those 3 rows were the alert loop itself |
| **`agent_health_probes`** (the `/health` body) | **12/12 alive, `loop_count` advancing, uptime 7.14 days** | **this is the true signal** |

Measured 2026-08-17 11:08 UTC: all 12 agents HTTP 200, `alive=true`, `loop_count` ≈ 15,600
and advancing, `last_iteration_at` within 0.9–1.5 min, `uptime_sec` 616,900,
`code_version` `8.2.0-reflect-wired` uniform, **`current_task_id` null on all 12**.

Two consequences:

1. **`PRIOR-WORK-INDEX.md`'s "the Trinity fleet is DOWN on Railway, and still is" is STALE.**
   It was correct when written 2026-08-15. The containers came back ~2026-08-10. The fleet
   is up and idle, not down.
2. The alert loop is *structurally* incapable of clearing, because nothing writes the field
   it reads. It will alert forever, and its own log rows are what made a second surface
   report fake liveness. **A dead sensor does not go quiet — it manufactures a signal.**

Fix dispatched (trinity-symphony-shared): read liveness from `agent_health_probes`, and add
a sensor-sanity guard — *when every reading is the failure value, suspect the instrument*.

---

## 2. T12 swarm capability — MEASURED with two canaries, both directions

This was measured rather than assumed, because LESSONS rule 1 says an agent asked for what
it has no instrument to obtain returns a plausible answer, not a failure.

**Canary A — task #435072, a live SQL inventory.** Claimed by `trinity-hdm` in **11 seconds**,
returned `done` in 47. The artifact contains **SQL that was never executed** — no results, no
counts, only query text, and the queries are themselves wrong (Section B's CTE does
`COUNT(*)` over `information_schema.tables` grouped by name, which returns 1 per row, not a
row count). The substance gate passed it because the artifact exceeds 40 characters.

**Canary B — task #435075, a pure reasoning critique with every input embedded in the task
text and tools explicitly forbidden.** Claimed by `trinity-veritas`. Returned a genuinely
strong argument: chose FLAGGED over ABSTAIN on the grounds that the two encode different
epistemic states ("ABSTAIN conflates *declined to assess* with *failed to assess*"), gave
the honest counter-argument to its own position, and named a failure mode the dispatching
brief had missed — that FLAGGED would fire on all **59** no-provider cases rather than only
the **41** that currently veto, relocating cost onto human reviewers rather than removing it.
It cited no number it was not given, and stated plainly that it had no tools.

**Verdict: T12 is a strong reasoning engine and a fabricating measurement engine.**
Give it work whose inputs are fully embedded in the task text. Never ask it to measure.
Equipping it with real tools is a separate piece of work and is not tonight's.

---

## 3. The defect that jumped the queue — proof verification is always-true

`src/routes/v1.ts`, `verifyProofCryptographically` (~line 156):

```
const valid = await verifierMod.verify(proofRow.proof_bytes, publicInputs);
return { valid: !!valid, cryptographically_verified: true, ... }
```

`@hyperdag/proof-verifier`'s `verify()` returns an **object**, not a boolean. `!!someObject`
is always `true`. So `POST /api/v1/verify-proof` reports **every** proof row with non-empty
`proof_bytes` as cryptographically verified — including proofs the verifier rejected. The
`catch` branch likewise returns `cryptographically_verified: true` on a WASM failure.

This is not merely a bug. **The correct fail-closed boundary already exists in this repo**
(`verifyProofLocally`, `src/services/trust-harness-verify.ts:49-102`), and
`tests/zkp-proof-verifier-crosscheck.test.ts:173` already pins the defect negatively with
the comment *"The classic bug this guards: `!!result` on an object is always true."*

LESSONS rule 3, exactly: a safeguard that is built, tested, and has no caller on the path
that matters. Fix dispatched.

---

## 4. HAL — the redundancy intuition is correct, with a number

Ruler: `hal_runner_results`, `hal_mode='fact-check-s2'`, `gen_failed=false`, 395 rows
(197 pos / 198 neg). Source: `trinity-ecosystem/docs/HAL-UNEARNED-VETOES-2026-08-17.md`.
**Not re-measured by this session — quoted with its ruler, per LESSONS rule 8.**

| stratum | n | vetoes | correct | wrong | veto precision | AUC |
|---|---|---|---|---|---|---|
| a provider ran | 336 | 166 | 159 | 7 | **0.9578** | **0.9746** [0.9574, 0.9917] |
| **no provider ran** | 59 | 41 | 19 | 22 | **0.4634** | **0.5150** (chance) |

On all 59, `providers_attempted` is empty: HAL emitted `FACTUAL_ERROR` having called
nothing, and those vetoes carry the same −10 RepID as an earned one.

Sean's instinct — *"when all agents reach a good disjointed family LLM his scores are very
good, so we need quick redundancy"* — is confirmed by this split. The highest-value HAL
change is not a threshold or a weight. It is: **a veto with no provider behind it must not
be issued.**

Dispatched with a precondition: the lane must first rule in or out whether
`providers_attempted` is itself corrupt. `src/hal/provider-width.ts:12-27` documents that
the sibling column `hal_providers_used` IS corrupt — 1,419 of 1,825 rows are `'{}'` and 81
smuggle a count into a name array. If the signal is bad, the finding collapses and the lane
must stop rather than ship a fix built on it.

**Two adjacent findings, not dispatched tonight, both real and both larger than they look:**

- **The DB penalty guard is row-cosmetic.** `trg_hal_penalty_guard` fires *after*
  `trg_apply_repid_score_event` because of trigger name-sort ordering, so it edits the audit
  record without retracting the score. **25,418 live rows carry `penalty_suppressed=true`
  AND `repid_delta_applied < 0`, summing −220,389 RepID actually deducted.** Recorded in
  `migrations/2026-08-03-hal-penalty-guard-trigger-order.sql:29-33,57-60`.
- **Issuer staking has no issuer.** `counterparty_agent_id` is NULL on all 70,020 live veto
  events, and `repid_score_events` has no provider column. Gate 2 in Sean's plan cannot be
  built until an issuer identity is recorded. That is a schema gate, i.e. Sean's.

---

## 5. ANFIS / LASSO — the ceiling is already measured, so the lane was re-aimed

`PRIOR-WORK-INDEX.md` CLOSED: **top-1 routing quality is at 98.16% of the omniscient bound**
(24 paired seeds). The whole remaining prize for any router change is **1.84pp**. Pointing a
lane at "make routing better with ANFIS" would have repeated the exact two-sprint mistake
that index exists to prevent.

What is actually unclosed is a capability gap:

- **What the code calls LASSO is not LASSO.** `lassoSelectFeatures`
  (`src/services/anfis-router.ts:47`) is `Math.abs(f * importance[i]) > threshold` with a
  hardcoded importance literal at `:73`. Same shape for `lassoDrivers`
  (`src/services/proof-tier-policy.ts:99`).
- **The one real LASSO has zero importers.** `fitLassoLogistic`
  (`scripts/eval/anfis-lasso.ts:183`) is a genuine L1-penalised logistic regression by
  coordinate descent. Nothing imports it.
- **The ANFIS rule parameters have never been fitted** — a hand-written 5×7 literal at
  `anfis-router.ts:82-88`.
- **And they cannot be fitted, because no joined (features → outcome) corpus exists.**

Measured live 2026-08-17 11:11 UTC:

| table | rows | labels | newest |
|---|---|---|---|
| `anfis_routing_logs` | 297 | success 297/297, latency 297/297, cost 126/297 | 2026-08-11 |
| `llm_call_log` | **486,344** | status / latency / cost **100%** | today |
| `routing_weights` | 6 | — | 2026-04-01 |
| `anfis_weight_history` | **0** | — | never |
| `anfis_trust_weights` | **0** | — | never |

The decision-time features are computed on every single route by `buildRoutingRecord()`
(`src/decisioning/routing-record.ts:125`) — the ordered candidate chain, each candidate's
cost class and skip reason — and then **thrown away**, printed to console only under a
default-off env flag. The outcomes are in `llm_call_log`, half a million fully-labelled rows.
Nothing joins them.

Lane re-aimed at closing that loop. Explicitly forbidden from changing any routing decision.

---

## 6. Agent → user RepID binding — five owners, none authoritative

Sean's goal: *"binding the agent RepID to the user RepID, thus making the agent subject to
the rules and settings of the user who owns it or is its custodian."*

Measured live 2026-08-17 11:12 UTC:

| table | rows |
|---|---|
| `repid_agents` | 176 |
| `repid_agents` with `builder_id` | **43** — so **133 agents (76%) have no human link at all** |
| `builders` | 75 |
| `human_agent_bindings` | **0** (table exists) |
| `agent_delegations` | **0** (table exists) |
| `agent_custodianship_links` | 1 |
| `agent_kya_registry` | 12 (`custodian_spending_authority` non-null on 2) |
| `human_sbt_registry` | 5 |

Five competing ownership mechanisms exist and none is authoritative: an unsigned admin FK
(`builder_id`, which the code itself disclaims as "not evidence of ownership"); a
well-designed signature-proven table with zero rows and no migration in-tree; signed
spending delegations with zero rows behind a default-off flag; custodian columns nothing
reads; and `conservator_address`, which is a decoy — it holds the *engine's own* minting
signer, i.e. the platform, not a user. Their key types do not even agree (uuid vs
`agent_name` text).

Meanwhile the ceiling that actually governs money (`x402-gate.decideAuthority`) reads
**only the agent's own tier**. Nothing about an owner constrains an agent today.

The real attenuation algebra — dual-signature grants, caveats (`maxValue`, `toolAllowlist`,
`maxCalls`), and the rule that a delegation may only ever *narrow* authority — already
exists in `trinity-ecosystem/lib/trustshell/identity/`, in shadow mode.

Lane dispatched to build the layer underneath enforcement: one canonical owner resolver with
an explicit assurance level and an explicit `unknown` (distinguished from "no owner", the
same NULL-is-not-false rule as the fleet view), plus owner→ceiling attenuation in **shadow**,
plus the measurement of how many of the 176 agents resolve to an owner at all. With zero rows
in both signed tables, switching enforcement on would break every caller and prove nothing.

---

## 7. What is blocked on Sean

| Item | Gate | Exact action |
|---|---|---|
| Redeploy T12 with the survivor-alert fix | Railway infra | Deploy `trinity-symphony-shared` once the fix is reviewed |
| Issuer staking / Gate 2 | schema DDL | `repid_score_events` needs an issuer identity — `counterparty_agent_id` is NULL on all 70,020 veto rows |
| The −220,389 RepID deducted under a cosmetic guard | DDL + policy | Trigger ordering fix, and a decision on whether to reverse historical deductions |
| Equipping T12 with real tools | infra | It reasons well and measures not at all; today it can only be trusted with embedded-input work |

---

## 8. Standing rules this session confirmed the hard way

1. **A dead sensor does not go quiet, it manufactures a signal.** The frozen heartbeat did
   not produce silence — it produced 154 confident false alarms in three hours, which a
   second surface then read as evidence of life.
2. **Measure the fleet's capability before dispatching to it.** One canary task, 60 seconds,
   caught a fabrication that would otherwise have arrived as twelve plausible reports.
3. **Read the ceiling before aiming a lane at a number.** The routing prize is 1.84pp and
   was already measured; the real gap was that the loop cannot learn at all.
