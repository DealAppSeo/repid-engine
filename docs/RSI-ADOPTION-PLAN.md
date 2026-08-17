# Adopting the OmegaHive ideas into HAL and the ZK-RepID layer

**Status: PLAN ONLY. No code, no schema, no config is changed by this document.**
Nothing here is applied without an explicit GO (CLAUDE-RULE-2). Every "we would
build X" below is a proposal with a promotion gate attached, not a commitment.

**Source:** Ben Goertzel, *Seeding RSI Toward ASI* (2026-08-07), and the three
design papers it summarises (the OmegaHive meta-algorithm, the ProtoAGI test
suite, and the qualification methodology). Read as an outside methodology to
borrow from — not as an architecture to copy.

**Scope:** `repid-engine` (HAL, scoring, `src/zkp/`), with two items landing in
`trinity-ecosystem` (`lib/trustshell/identity/*`, the TrustShell surface).

---

## 0. Two corrections this plan is built on

**`zkRepID` is not a name in this codebase.** Grepped across all four repos on
2026-08-17: zero hits, in any casing. The layer that answers to that description
is `src/zkp/` — `commitment.ts`, `merkle-root.ts`, `nullifier-identity.ts`,
`repid-delta-statement.ts`, `repid-delta-bridge.ts`, `proof-statement-guard.ts`,
`delta-anchor.ts`, `erc8004-linkage.ts`, `poseidon2-*` — plus the "ZKP Postcard"
link in the NORTH-STAR spine. This plan uses **ZK-RepID** to mean exactly that
set of files and nothing else. If the name is meant to become canonical it needs
a rename PR of its own; adopting a term that names no code is the precise
failure LESSONS §5 is about.

**We are not short of ideas. We are short of a loop.** Reading Goertzel against
this tree, the striking thing is how much of his *discipline* was already
invented here independently and under different names — and how little of it is
wired to anything standing. `measurement-ruler.ts` is the evaluation-ecology
rule stated as a refusal. `baseline-ledger.ts` is matched-conditions comparison.
`run-ablation.ts` is a causal ablation with a trivial floor already in it
(scorer A, plain 3-LLM majority). Each was built for one sprint, produced one
report, and stopped. **The gap is not the mechanisms; it is that nothing runs
them on a cadence and nothing is allowed to be promoted by their output.** That
is what the OmegaHive paper actually supplies, and it is what we should take.

---

## 1. Concept map — what we have, honestly graded

`HAVE` = built and running. `PARTIAL` = built, single-use or unwired.
`MISSING` = not present.

| Goertzel concept | Our nearest thing | Grade |
| :-- | :-- | :-- |
| Evaluation ecology (a *profile*, never one score) | `src/hal/measurement-ruler.ts` — F1 is unspeakable without corpus hash, case count, family width, strictness. `corpus-manifest.ts`, `measurement-integrity.ts` (a degraded run yields no quality number) | **PARTIAL** — the ruler discipline is best-in-class, but it rules **one axis**: detection F1. No breadth / transfer / calibration / cost / latency / governability profile exists. |
| Baseline → add one mechanism → evaluate → tune → promote/park/reject | `scripts/hal-ablation/run-ablation.ts`, `scripts/hal-eval/shadow-compare.ts`, `src/orchestration/baseline-ledger.ts` (`certifyDelta` refuses an uncomparable delta) | **PARTIAL** — all three exist; none is on a cadence, there is no candidate registry, and no `park` state at all. |
| Shadow mode, authority earned by measurement | `src/services/anfis-shadow-persist.ts`, `docs/SHADOW_REJECT_CAPABILITY.md`, `CONSTITUTIONAL_AUDIT_ENABLED` (default false) | **PARTIAL** — shadow exists; **promotion out of shadow is a human flipping an env var**, with no recorded criterion. See §3.2. |
| Module Space (typed interface; incumbent and candidate side by side) | `src/providers/router.ts`, `src/services/anfis-router.ts`, `src/zkp/proof-router.ts`, `src/hal/lib/*` | **PARTIAL** — three routers, three shapes, all bespoke. Layers are imported directly (`src/engine/repid-update.ts` → `src/layers/*`), so a candidate cannot be run beside an incumbent generically. |
| Context Frame (durable task state: goals, hypotheses, **predictions**, budgets, provenance, completion criteria) | `trinity_tasks`, `repid_score_events`, `src/memory/proof-carrying-memory.ts`, `src/decisioning/routing-record.ts` | **PARTIAL** — durable state, spread over many tables, carrying **no prediction, no budget, no completion criterion**. |
| **Commit a prediction before a consequential action; environment returns an authenticated receipt** | Receipts: `src/services/trust-receipt.ts`, `quorum-receipt-writer.ts`, `kya_compliance_receipts`, the audit chain, `src/zkp/*` | **MISSING (the prediction half)** — we have possibly the best receipt infrastructure of anyone doing this, and **nothing is committed before the action**. This is the single highest-value import in the paper and the cheapest for us. See §3.1. |
| Test qualification: trivial floors, classical + learned specialists, public-interface oracle, privileged oracle, regret | Scorer A in `run-ablation.ts` is a genuine trivial floor. `scripts/eval/model-leaderboard.ts`, `eval/rigorous/`, `eval/canary/` | **PARTIAL** — one floor, on one axis, once. No oracle ceiling anywhere, therefore **no regret and no attainability bound**. |
| Pathological controls (bad agents must score badly) | `src/testing/red-team.ts`, `redteam-adjudication.ts`, `src/services/exchange-red-team.ts`, `src/hal/injection-guard.ts` | **PARTIAL** — adversaries against the *product*; none against the *scorer*. Nothing checks that a wasteful or overconfident agent ranks where it belongs. |
| Anti-gaming: re-skin invariance, planted internet-answerable items | `src/hal/ground-truth-gate.ts`, `measurement-integrity.ts`, `corpus-manifest.ts` hashing | **MISSING** — corpora are hashed and frozen but never re-skinned, and nothing detects memorisation. |
| Factorial comparison (0, X, Y, Z, XY, XZ, YZ, XYZ) | `run-ablation.ts` isolates exactly one factor (the Comma) | **MISSING** as a harness. |
| Frozen-state vs developmental trials | everything we run is frozen-state | **MISSING** — though `EarnedMetrics` decay is time-dependent, so a developmental substrate genuinely exists. |
| Independent voters / de-correlated evidence | `src/hal/checkpoint-registry.ts` (curated host+model → weights identity; an unmapped model becomes its own singleton and can only *reduce* independence), `src/decisioning/family-registry.ts`, `disjointness.ts` | **HAVE** — and it is *ahead* of the paper, which discusses diverse baselines but not vote-independence laundering. Flag this as ours. |
| Forks explore in parallel, best pieces merged back | `src/orchestration/lane-registry.ts`, `write-lease.ts`, `node-registry.ts`, XC/GA dispatch | **PARTIAL** — lanes exist to prevent write collisions, not to explore an architecture search space. Merging is by PR, not by measured promotion. |
| Value system moved out of the LLM into a structured, inspectable substrate | `src/layers/constitutional-audit.ts`, `LESSONS.md` injected into every dispatch, `src/resilience/decision-contract.ts`, `emergency-halt.ts` | **PARTIAL / honest stub** — the constitutional audit's three primitives return "all rules", "1.0", and "true" unconditionally, correctly gated off and correctly labelled. `src/services/anfis-comma.ts` is a complete ANFIS forward pass with **zero call sites**. |

**Read the table this way.** Nine `PARTIAL`s in a row is not a mediocre score.
It says the parts were built by people who understood the problem, and then
nothing came along to hold them together. The paper's contribution to us is the
holder.

---

## 2. What we should take, and what we should decline

### Take

1. **The loop as a standing object** — baseline → one mechanism → evaluate →
   tune → promote / **park** / reject → repeat. Especially `park`: we have no
   way to record "measured, not good enough yet, revisit after its neighbours
   land," so mechanisms either merge or die.
2. **Committed prediction + authenticated receipt.** §3.1. Highest value, lowest
   cost, and it is a *product* claim, not only an internal one.
3. **Qualifying the test before trusting the test** — floor, specialists,
   oracle ceiling, regret, pathological controls, difficulty bands.
4. **Profile over scalar** — the weakest capability family counts at least as
   much as the average.
5. **Shadow mode as the default posture for any new mechanism**, with authority
   granted only by recorded measurement.

### Decline

- **The Omega\* brand names** (OmegaClaw, OmegaHive, OmegaBuzz). They are
  SingularityNET's identity. Take the concepts under generic or our own names;
  borrowing the brand would misrepresent a relationship we do not have.
- **The full ten-environment ProtoAGI suite** (AGI Maze, RoboGarden, LeanGarden,
  Neoterics…). We are not building a general mind. Ninety per cent of that suite
  measures capabilities TrustShell does not claim and will never have. Take
  **RepoOps** and **SelfLab** in spirit only — they map to work we already do.
- **AGI framing in any public artifact.** This repo is public. "We are building
  toward AGI" is a claim with no measurement behind it, in a repo whose entire
  culture is that unmeasured claims get retracted. The methodology is adoptable;
  the destination is not ours to assert.

---

## 3. The four proposals, ranked

### 3.1 — Committed predictions, and calibration as an earned score

**The idea.** Before a consequential action, the agent commits a prediction:
expected outcome, cost, latency, and its own confidence. The environment returns
an authenticated receipt. Later, the outcome is compared to the commitment.

**Why it fits us better than it fits them.** Goertzel needs to *build* the
authenticated-receipt half. We already have it: `trust-receipt.ts`,
`quorum-receipt-writer.ts`, the audit chain, Merkle roots in
`src/memory/memory-root-anchor.ts`, on-chain anchoring in `src/zkp/delta-anchor.ts`
and `erc8004-linkage.ts`. We are missing only the commitment half — and the
commitment half is a hash written before an action, which is the cheapest thing
in this entire document.

**What it changes about RepID.** Today RepID scores *outcomes*. With committed
predictions it can score **calibration**: an agent that says "I am 95% sure" and
is right 60% of the time is a different, worse agent than one that says "I am
60% sure" and is right 60% of the time — and today they score identically.
`certainty_at_claim` is already a first-class HAL signal
(`docs/HAL_CANONICAL_v1.md`), and the live scoring path derives its entire
dissonance from certainty. **We already treat self-reported confidence as
load-bearing without ever checking whether it was earned.** That is a real hole
and this closes it.

**Why it is a ZK-RepID feature, not just a HAL one.** A calibration record is
exactly the thing an agent wants proven and does not want disclosed. "Over my
last N committed predictions my Brier score is below X" is a statement of the
same shape as the RepID-delta statements `src/zkp/repid-delta-statement.ts`
already handles, over a Merkle set the memory layer already builds. **A portable,
private, checkable calibration record is a claim nobody else in this space can
currently make.** It is also the strongest possible answer to "why does RepID
need a ZK proof at all" — a question the current score, which is a public
integer, answers weakly.

**Shape (proposal, not applied).**
- Extend the Context Frame (§3.3) with a `commitment` block: predicted outcome,
  predicted cost, predicted latency, self-confidence, hash, timestamp.
- Commitment hash written **before** dispatch; refused after.
- On settlement, a `prediction_receipt` joins commitment to observed outcome.
- A calibration metric (Brier / ECE) over an agent's receipt set, decayed the
  same way `EarnedMetrics` is.
- A ZK statement over the receipt Merkle set proving a calibration threshold
  without revealing the predictions.

**Promotion gate.** Ships in shadow, contributing nothing to any RepID delta,
until: (a) commitment-before-action is enforced by a test that fails when the
order is reversed — LESSONS §6, a test that cannot fail is a liability; (b) the
pathology suite (§3.4) shows a systematically overconfident agent scoring worse
than a calibrated one of equal accuracy; (c) a proof verifies against a
commitment set the verifier never saw.

---

### 3.2 — The Promotion Ledger: a mechanism earns authority, or stays in shadow

**The idea.** Every new mechanism enters in shadow, is measured against the
incumbent under matched conditions, and is `promoted`, `parked`, or `rejected` —
with the measurement that decided it recorded alongside the verdict.

**Why we need it specifically.** `CONSTITUTIONAL_AUDIT_ENABLED` has been false
since 2026-07-05 with no written criterion for what would turn it true. There
are two ANFIS implementations, one of which (`src/services/anfis-comma.ts`) is a
complete forward pass with zero call sites. `docs/SHADOW_REJECT_CAPABILITY.md`
is a designed, unbuilt fix with a written verification plan and no owner. These
are not three separate stalls; they are one missing institution. **LESSONS §3
says an unwired mechanism is worse than an absent one because it converts a known
gap into false coverage. A promotion ledger is the enforcement of §3 for
mechanisms rather than for safeguards.**

**Shape.** One table plus one gate function. A mechanism has a state
(`shadow` / `promoted` / `parked` / `rejected`), an incumbent it is measured
against, a ruler (`MeasurementRuler`, reused verbatim — this is what it is for),
a verdict, and the delta that justified it, certified through
`baseline-ledger.certifyDelta` so an uncomparable pair refuses rather than
passes. `park` carries a re-open condition: *"revisit when the ANFIS retune
lands."*

**Deliberately reuses, does not rebuild:** `measurement-ruler.ts`,
`measurement-integrity.ts`, `corpus-manifest.ts`, `baseline-ledger.ts`,
`handoff-gate.ts`'s `MeasuredValue`. If this needs new measurement primitives,
the design is wrong.

**Promotion gate for the ledger itself.** It is real when three existing stalled
mechanisms have been entered into it and each has a verdict with a ruler
attached — the constitutional audit, `commaANFIS`, and the shadow-reject
capability filter. Not before. A registry with nothing in it is `canAssign()`
again (LESSONS §3).

---

### 3.3 — Module Spaces and Context Frames: adopt both terms

**Module Space** — one typed interface behind which a mechanism sits, so an
incumbent and a candidate can run side by side without the caller knowing. We
have three routers of three different shapes and a scoring pipeline that imports
its layers directly. **Do not rewrite the routers.** Define the interface, and
apply it to exactly one boundary first: the HAL signal extractor, where two
implementations already coexist and disagree (path A `extractHALSignals`, path B
the certainty-only inline extractor in `src/routes/agents-external.ts` — see
`docs/HAL_CANONICAL_v1.md`, which documents the dissonance between them). That
disagreement is a Module Space that already exists in fact and not in code, and
it is the natural first proof of the abstraction.

**Context Frame** — durable task state that outlives any model's context window.
We have durable state; what we lack is the *frame*: goals, hypotheses,
predictions, budgets, provenance, and **completion criteria** in one addressable
object. Completion criteria matter here beyond the paper's reasons: NORTH-STAR
records nine competing "what do I do next" surfaces, and `trinity_tasks` is
canonical precisely because the others had no completion semantics.

Both terms are good, neither collides with anything of ours, and adopting them
gives HAL and the swarm a shared vocabulary they currently lack. **Take them
verbatim, with attribution in the doc that introduces them.**

---

### 3.4 — Qualify the instrument: floors, ceilings, regret, pathologies

**The idea.** A test you have not qualified is not a measurement. Establish a
trivial floor (random / greedy / do-nothing), transparent classical specialists,
learned specialists, a public-interface oracle (strongest solver, same
observations), and a privileged oracle (given hidden state) — then measure across
a difficulty surface, not at one hand-picked setting.

**Why this is urgent here and not merely nice.** `trinity-ecosystem/CLAUDE.md`
opens with two sprints spent optimising a component **already at 97.9% of its
theoretical bound, because nobody computed the bound.** Goertzel's oracle ceiling
is exactly that bound, made routine. We have never computed one for HAL. Our F1
numbers — which have already been quoted at four different values under four
different rulers (LESSONS §8) — are stated with no floor beneath them and no
ceiling above them. **A number between an unknown floor and an unknown ceiling
carries no information about how much room is left.**

Scorer A in `run-ablation.ts` is already a legitimate trivial floor. The paper's
contribution is: do that always, add the ceiling, report the regret.

**The pathology suite is the second half and we have none of it.** Everything in
`src/testing/red-team.ts` attacks the product. Nothing attacks the *scorer*. The
paper's controls translate directly:

| Pathological agent | Must rank | We can build it from |
| :-- | :-- | :-- |
| Hyperactive (10× the calls, same artifact) | worse | quorum width / cost accounting |
| Overconfident (high `certainty_at_claim`, same accuracy) | worse | §3.1 calibration |
| Provenance-breaking (right answer, no evidence) | worse | `proof-carrying-memory.ts` |
| Corpus-memorising | worse on re-skin | §3.4 re-skin invariance |
| Honest abstainer ("the evidence cannot distinguish these") | **better**, not worse | `completeness.ts`, `ground-truth-gate.ts` |

That last row is the one to build first. Our whole culture — VERIFIED /
NOT_CHECKED / FAILED, "I could not measure this is a SUCCESS" (LESSONS §1) —
says an honest abstention should score well. **We have never checked that our
scorer agrees with our culture.** If it does not, that is a finding worth more
than most sprints.

**Re-skin invariance**: paraphrase or re-render a corpus case in a way that
cannot change the truth value; the verdict must not move. Cheap, and it is the
only defence we have against the eval corpora ageing into memorised sets.

---

## 4. Terminology: adopt, adapt, decline

| Their term | Our decision | Note |
| :-- | :-- | :-- |
| Module Space | **Adopt verbatim** | No incumbent term. Attribute on introduction. |
| Context Frame | **Adopt verbatim** | Slots onto `trinity_tasks`. |
| Evaluation ecology | **Adopt as a concept, keep "ruler" for the unit** | A ruler measures one instrument; the ecology is the profile of rulers. They compose. |
| Shadow mode | **Already ours** — keep | `anfis-shadow-persist`, `shadow-compare`, `SHADOW_REJECT`. |
| Promotion gate | **Adopt** | Fits `handoff-gate`, `ground-truth-gate`, `execution-floor`. |
| Promote / **park** / reject | **Adopt** — `park` is the new one | We have no way to say "measured, not yet". |
| Trivial floor / oracle ceiling / regret | **Adopt, but name them `qualificationFloor` / `oracleCeiling`** | `execution-floor.ts` already means something else. Do not collide. |
| Pathological controls | **Adopt as "pathology suite"** | Distinct from red-team, which attacks the product. |
| Frozen-state vs developmental trial | **Adopt** | Names a distinction we make implicitly. |
| Factorial comparison | **Adopt** | Generalises `run-ablation.ts`. |
| Committed prediction / authenticated receipt | **Adopt, and make it ours** | We should ship this before they do; the receipt half is already built. |
| OmegaClaw / OmegaHive / OmegaBuzz / metahive | **Decline** | Their brand. Ours are agents, the fleet, and lanes. |
| PRIMUS, AtomSpace, cognitive pluralism | **Decline** | Names a cognitive architecture we do not have and are not building. |
| ProtoAGI test suite, AGI Maze, RoboGarden, LeanGarden, Neoterics | **Decline** | Measures capabilities TrustShell does not claim. |
| "RSI", "seeding ASI", "global brain" | **Decline in all public artifacts** | Unmeasured claims in a public repo. §2. |

---

## 5. Sequence

Every phase is shadow-first and gated. Phases 2–4 are only reachable through
the gate above them.

**Phase 0 — precondition, owned elsewhere.** The fleet is down (NORTH-STAR,
2026-07-17). Every measurement below needs a live producer. **Nothing in this
plan is measurable until the redeploy lands.** Phase 1 is doc-and-design work
that can proceed in the meantime; Phase 2 onward cannot. Saying so here is the
point — a plan that quietly assumes a live substrate is how a stalled surface
starts looking current.

**Phase 1 — vocabulary and the ledger (no behaviour change).**
Define Module Space and Context Frame as types. Stand up the Promotion Ledger
with the three stalled mechanisms entered and honestly graded. Nothing is
promoted. *Gate: three verdicts, each with a ruler attached.*

**Phase 2 — qualify the instrument.**
Oracle ceiling and qualification floor for HAL's frozen corpus; report regret,
not raw F1. Build the pathology suite, starting with the honest abstainer.
Re-skin invariance on the canary corpus. *Gate: a pathological agent that
currently scores well is found and named, or the suite is shown to rank all six
correctly.*

**Phase 3 — committed predictions, in shadow.**
Commitment block on the Context Frame; `prediction_receipt` on settlement;
calibration computed and **contributing nothing** to any RepID delta. *Gate: the
three conditions in §3.1.*

**Phase 4 — ZK calibration statement.**
Extend `src/zkp/repid-delta-statement.ts` to prove a calibration threshold over
a commitment Merkle set. *Gate: verified by a party that never saw the
predictions.*

**Phase 5 — promotion by measurement, not by env var.**
Only after 1–4: allow the Promotion Ledger to gate a real authority change, and
retire the first `*_ENABLED` boolean in favour of a recorded verdict.

**Not in scope:** parallel architectural forks, cross-fork merging, anything
metahive-shaped. Those need Phase 1–5 to exist first, and probably a second
team.

---

## 6. What would count as progress here — and what would not

Adapted from the paper's list, made specific to this stack.

**Would count:**
- HAL's regret against an oracle ceiling falls. (Today it is unknown, which is
  the finding.)
- A pathological agent that currently scores *well* is found and demoted.
- An honest abstention scores better than a confident wrong answer.
- A mechanism is promoted out of shadow by a recorded measurement, with no human
  flipping a flag.
- A calibration proof verifies against predictions the verifier never saw.
- A number survives a re-skin of its corpus.
- Verdicts hold under a fresh ruler — i.e. LESSONS §8 stops recurring.

**Would not count:**
- More mechanisms, more tables, more docs, more reports. This repo has 116 dated
  reports and the paper's own warning is that internal activity is not evidence.
- An F1 improvement with no floor and no ceiling reported beside it.
- A Module Space with one implementation behind it.
- A Promotion Ledger with nothing entered.
- Adopting the vocabulary without the loop. **This is the likeliest failure mode
  of this document**: renaming things is cheap, satisfying, and produces exactly
  zero measurement. If Phase 1 lands and Phase 2 does not, this plan made things
  worse — new terms, same stalls.

---

## 7. Risks

- **Terminology adopted, methodology skipped.** See above. The mitigation is
  that Phase 1's gate is three *verdicts*, not three definitions.
- **The evaluation apparatus outgrows the thing it evaluates.** Goertzel is
  building toward a general mind and can amortise a ten-environment suite. We
  have one detector and one score. Every environment we do not need is pure
  cost. Hence §2's decline list.
- **Nothing is measurable while the fleet is down.** Phase 0.
- **Public repo.** Findings, never inventories (`CLAUDE.md`). This plan is
  deliberately free of counts, ids, and service names.
- **CLAUDE-RULE-3.** Each phase touches one boundary. The Module Space work in
  particular must not become a router refactor.

---

## 8. Open questions for Sean

1. **Is calibration a RepID input, or a separate portable score?** §3.1 changes
   what RepID *means*. Folding it into the existing score alters every published
   number; a parallel score does not, but splits the product claim in two.
2. **Should `zkRepID` become the canonical name for `src/zkp/`?** If yes it is
   its own rename PR before anything here builds on it.
3. **Phase 1 during the outage, or hold everything until the redeploy?** Phase 1
   is genuinely doc-and-type work and does not need a live producer — but it also
   cannot be validated without one.
4. **Do we say publicly that we borrowed this?** I would: attribution costs
   nothing and the methodology is stronger with a citation than without. But it
   attaches our public repo to an AGI-framed source, and §2 declines that framing.
