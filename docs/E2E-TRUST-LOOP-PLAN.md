# E2E trust loop — the plan, and three landmines found while validating it

**Status 2026-08-21.** Locked after a Sean / Claude / Grok-team round. Everything below
that says MEASURED was run; everything that says NOT_CHECKED was not.

The target loop: **a human stakes USDC for a linked agent → that agent buys a service from
another agent → the outcome is classified → RepIDs move in a risk-proportional, just-culture
way → high-risk outcomes are attested on chain and independently verifiable.**

The organising principle is **irreversibility, not visibility**: the system has zero users
today, and the decisions that get expensive after users are the ones to make now.

---

## Task

### 0. Read this before planning anything on this track

**The incentive design you are about to propose is already largely built.** Two rounds of
planning nearly re-specified it. What exists, tested and green:

| Piece | Where | What it already does |
|---|---|---|
| Outcome classes | `src/services/outcome-classification.ts` | 7 classes, confidence-scaled penalties. Tested invariants: `REFUSED_CORRECTLY > FAILURE_AGENT_FAULT at any confidence`, and `\|confident error\| > success at equal value` |
| Just culture | `src/services/repid-confession.ts` + `src/routes/repid-confess.ts` | NASA-ASRS-modelled self-report. `SELF_REPORT_DISCOUNT = 0.4`, invariant-tested strictly between 0 and 1 |
| Anti-wash-trading | `src/services/x402-outcome-link.ts` | No-proof-no-pay: unanchored success is demoted, not trusted |
| Authority damping | `src/services/effective-authority.ts` | `A_eff = min(R_route, 100·√S_real) · 1[builder ≥ 500]` |
| The E2E arithmetic | `tests/x402-repid-outcome-link-e2e.test.ts` | good / bad / asymmetry / rater-weighting / simulated-earns-zero / composite |

**Do not rebuild any of it.** The gap is wiring and ledger, not logic.

---

### 1. Three landmines, found by running rather than reading

Each of these would have silently broken the plan. All three were found in one validation
pass against the live database.

#### L1 — "shadow mode" via `repid_delta_calculated` was inverted **[MEASURED, FIXED]**

Both plans green-lit *"write `repid_delta_calculated` only, apply nothing."* The trigger read:

```sql
v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
```

`repid_delta_calculated` is the **applied** path, and it takes **priority over `delta`**.
Writing "calculated-only" rows would have applied every one of them. Shadow mode would have
silently been enforce mode — the exact failure class this codebase exists to catch.

**Fixed:** explicit `is_shadow boolean NOT NULL DEFAULT false`, with early-return guards in
all three triggers that act on a score event. Never overload an existing field for this.

#### L2 — `agent_repid_history.payment_proof_hash` is UNIQUE, fallback is a constant **[MEASURED, NOT FIXED]**

When the apply trigger writes `agent_repid_history`, it fills `payment_proof_hash` by
falling back through three sources in order:

1. `metadata->>'tx_hash'` on the score event
2. the event's idempotency reference
3. failing both, a hardcoded placeholder string

`payment_proof_hash` has a **UNIQUE constraint**, and that placeholder already occupies it.

> The fallback chain is quoted as prose rather than as its literal SQL line: the secret
> scanner reads a quoted `0x…` value next to the word `key` as a credential. It is a
> placeholder, not one — but rewording costs nothing, whereas a `.gitleaksignore` entry is
> a permanent blanket exemption that outlives the reason it was added.
So **any trigger-applied score event with neither a tx hash nor an idempotency key fails its
entire INSERT** — not the history write, the whole event.

This sits directly on the Phase-1 path. Two unanchored events in a row is all it takes.

**Not fixed here** — it is a real schema decision (drop the constraint? make the fallback
unique? require an anchor?) and belongs to whoever owns settlement semantics. **Until then,
every writer on this path MUST supply `idempotency_key`.**

#### L3 — `trg_repid_earned_floor` is a reputation ratchet **[MEASURED, POLICY DECISION]**

An agent cannot fall below `tier_lower_bound(peak_repid)`. Measured: an agent that peaked at
10000 took a −999999 event and landed at **8000**, not the [10, 10000] floor.

**This substantially undercuts the asymmetry the scoring layer is built on.**
`outcome-classification.ts` states *"reputation should be earned gradually and lost quickly"*
and tests that a confident error costs more than a success earns. The ratchet means an agent
that touches VETERAN **once** is permanently insulated below 8000 regardless of later
behaviour. With real users that is a bad actor with a guaranteed floor.

There is an escape hatch (`app.bypass_repid_floor`) and a per-agent `floor_override`.

**Open decision for Sean — do not change unilaterally.** A soft-landing ratchet is defensible
(it prevents one catastrophic event from erasing a career, which supports the just-culture
goal). A permanent tier floor is not obviously the right shape. Options: decay the floor over
time, tie it to sustained behaviour rather than peak, or scope it to non-fault events only.

##### L3 quantified **[MEASURED 2026-08-21, XC S1 + a direct probe]**

The original entry showed the clamp exists — one −999999 event landing at 8000. It did not
show what **repeated realistic** faults do, which is the question the policy turns on. Probed
with 25 consecutive confident faults (−116, the value from the measured triad) against an
agent peaked at 10000, and a never-peaked control:

- Faults 1–17 cost the full −116 each. The per-event asymmetry is intact **above** the floor.
- Fault 18 is **partially absorbed** (−28, the remaining distance to 8000).
- **Faults 19 onward cost exactly 0.** Every subsequent confident fault is free.
- The control, never peaked, loses −116 on every event throughout.

So the per-event invariant holds and the **career invariant does not**: once an agent touches
VETERAN, the marginal cost of defecting is zero, permanently. XC reached this by inference;
this is the measurement.

**XC's break-even, checked and correct.** Climb to the floor is 312 capped successes from a
200 start (`⌈7800/25⌉`, needing value ≥ 156.25 at full confidence, each anchored), or 3900
refusals at a flat +2 with no settlement at all — `REFUSED_CORRECTLY` is deliberately not
value-scaled, which stops big-refusal farming but not *many-small*-refusal farming. Because
both an honest agent and a defector pay that climb, **the climb cost cancels**, and "spike
then defect" beats honest play exactly when the per-period defection surplus exceeds the
honest one. On RepID accrual the attack loses (it is stuck at 8000 while honesty continues to
10000); on extractable value it wins.

Two amplifiers XC identified that are worth keeping in view: rater weight at the 8000 floor
stays ≈0.98 of maximum, so a defector retains near-full power to weight *other* agents'
penalties; and `A_eff` binds on stake below `S = 6400`, so at typical stakes 8000 and 10000
buy **the same spendable authority** — the 2000 points of "lost" reputation cost the attacker
nothing operationally.

**This does not decide the policy.** It says a permanent tier floor makes defection free at
the margin, and names the options: decay the floor, tie it to a sustained window rather than
peak, scope it to non-fault events, or have routing and rater weight consume a windowed score
instead of the ratchet-clamped one.

Related drift: CLAUDE.md documents `compute_tier(integer)`. It is now
`compute_tier(integer, uuid)`. The verification command in CLAUDE.md no longer resolves.

#### L4 — the ledger cannot hold the deltas the policy computes **[MEASURED, MITIGATED]**

`delta` and `repid_delta_calculated` are `integer`. `deltaFor` returns two decimal
places. Postgres casts numeric to integer by rounding **half away from zero** — probed in
a rolled-back transaction: `-24.75 → -25`, `-0.5 → -1`, `0.4 → 0`, `0.5 → 1`, `2.4 → 2`.

The tested invariants survive it. A confident fault is roughly 12x a success at equal
value, and rounding cannot invert a 12x gap — so this is **not a scoring bug**.

It is a **replay bug**, and replay is the entire purpose of shadow rows. The
`FAILURE_COUNTERPARTY` "whisper of negative" is specified as `-0.5`, lands as `-1`, and
is unrecoverable; every positive delta below 0.5 disappears. *You cannot tune a weight
whose whole effect is smaller than the quantum your ledger can store.*

**Mitigated in application code, not by a schema change.** The rounding is now performed
explicitly by the same rule Postgres would have used, so the number written is one we
chose; and the exact value is preserved beside it as a fixed-point integer at the
`DELTA_ENCODING_SCALE = 100` this codebase already uses for exactly this problem. A
re-tuning run reads the exact value. Whether the column should become `numeric` is a
schema decision and is left open.

#### L5 — deleting an agent deletes its reputation history **[MEASURED, POLICY DECISION]**

Read from the live constraints while validating the shadow writer:

- `repid_score_events_agent_id_fkey` is **`ON DELETE CASCADE`**. Deleting an agent row
  removes every score event it ever had. An append-only audit log that a `DELETE`
  silently erases is not append-only.
- `repid_score_events_counterparty_fkey` is **`ON DELETE SET NULL`**. Deleting a
  counterparty rewrites the counterparty out of every past event that named it.
- **`builder_id` has no foreign key at all.** It is a bare `uuid`, so a typo is accepted,
  permanent, and invisible. It was added on 2026-08-21 and no writer existed yet to
  constrain it — this is the moment to decide what it references, if anything.

Not changed here. Retention and deletion semantics on a reputation ledger are a policy
question (and interact with erasure requests), not a cleanup.

#### L6 — the event-type whitelist cannot say "an outcome was classified" **[MEASURED, WORKED AROUND]**

`repid_score_events_event_type_check` admits 36 values, none of which means *an outcome
was classified*. Every mapping from an outcome class onto it is therefore lossy, and two
distinct classes have to share one `event_type`.

Worked around rather than solved: the mapping never files a failure as a delivery, and
the **exact class is written to `decision_outcome`**, which is authoritative. Nothing may
branch on `event_type` for attribution. The real fix is a whitelist addition — an
external schema change, and it belongs to whoever owns that constraint.

#### L7 — the just-culture path could not write a single event **[MEASURED, FIXED]**

The most consequential of the seven, and it surfaced only because the confession leg of the
E2E was *run* rather than read.

`repid-confession.ts` writes `event_type = 'SELF_REPORTED_FAILURE'`. **That value was not in
the whitelist.** Probed in a rolled-back transaction: `23514 check_violation`.

The failure mode is the one this codebase exists to catch. `recordConfession()` writes the
confession-log row first — deliberately, so a disclosure survives a ledger failure — then
attempts the score event, and on failure returns `ok: true` with the error demoted to a
`warning` field. **A caller that checks the obvious field is told the confession
succeeded.** The confession row exists. The penalty does not.

So an agent confessed and **its score did not move at all**. The discount is set to `0.4`
and invariant-tested strictly between 0 and 1 — while the effective discount in production
was **0**. That is not the parity case, it is the *free* case, which the module's own header
names as the one that "prices in reputation laundering". A mechanism built to make honesty
cheaper than concealment was instead making honesty free, and therefore indistinguishable
from saying nothing.

Zero confession-log rows and zero such events confirm nobody had ever exercised it. **An
unwired mechanism is worse than an absent one**, because a reviewer reading the schema
concludes just-culture is handled.

**Fixed** by adding the value to the constraint — strictly additive, so a CHECK admitting
more values cannot reject a row it previously accepted. The existing test asserted the event
type was *distinct from every detection-shaped one*; nothing asserted the database would
take it. **A name is not a channel.** `tests/event-type-whitelist.ts` now holds the schema's
answer once, and both the confession path and the shadow writer assert against it.

#### L8 — `repid_config.min_value` / `max_value` enforce nothing **[MEASURED, OPEN]**

Found while seeding the confession-window keys. That table carries **no CHECK constraint and
no trigger** — probed by setting a bounded key outside its own declared range in a
rolled-back transaction: accepted, no error.

So every declared bound on a live-tunable knob is documentation. That matters most where a
knob is load-bearing: setting `late_self_report_discount` to `1.0` makes late disclosure
cost exactly what detection costs, and an agent holding an undisclosed failure then faces
*"pay P for certain"* against *"pay P only if caught"* — **concealment becomes strictly
dominant again**, reinstated by one config edit, with no error and no alarm.

Enforced in application code for this path (`resolveTimingPolicy` refuses any value breaking
`prompt < late < 1` and reports what it refused). **Not fixed table-wide** — that governs 25
knobs other people own.

**Pre-verified for whoever takes it:** 25 rows declare bounds, **0 currently sit outside
their own bounds**, and 0 have a non-numeric value alongside bounds. A CHECK enforcing the
declared range would therefore validate cleanly today. That is the cheapest it will ever be.

#### L9 — the ledger recorded movements that never happened **[MEASURED, FIXED]**

Found while turning XC's L3 claim into a measurement, and it is the reason that measurement
had to be run rather than reasoned about.

An agent whose peak reached VETERAN takes repeated confident faults. Once its score reaches
the tier floor, `current_repid` **does not move at all** — while every score event recorded
`repid_delta_applied = -116` and a `repid_after` 116 points below the score the agent
actually held. `agent_repid_history` recorded the same false delta.

| # | What the score did | What the ledger said |
|---|---|---|
| 17 | 8144 → 8028 | applied −116, after 8028 ✓ |
| 18 | 8028 → **8000** (partially absorbed) | applied −116, after **7912** ✗ |
| 19+ | 8000 → **8000** (fully absorbed) | applied −116, after **7884** ✗ |

**Cause.** `apply_repid_score_event` writes `current_repid`, and `trg_repid_earned_floor`
then fires on `repid_agents` and raises it back to `tier_lower_bound(peak_repid)`. By then
the score event has already stamped its before/after from its own arithmetic.

This is the same class as the [10, 10000] clamp fixed earlier — *"log the delta actually
applied, not the one requested"* — except the clamp lives inside this function and the floor
lives in a different trigger that runs afterwards. Fixing one did not fix the other, and the
first fix's own comment made it look as though it had.

**Why it is worse than L3 itself.** L3 is a policy question Sean gets to answer. This made
the answer *unobtainable*: any analysis of ratchet insulation reads a ledger that positively
asserts the penalties landed. It also silently invalidated replay for every VETERAN-peaked
agent — the whole point of the `policy_version` work.

**Fixed** by reading back what actually landed (`RETURNING current_repid`) instead of
trusting the value we asked for. Deliberately **not** a copy of the floor logic: a second
copy drifts from the first, and would also miss `floor_override`, `app.bypass_repid_floor`,
and any future trigger that adjusts a score. Reading the row is correct against all of them,
including the ones not yet written. **No score and no policy changed** — only what the ledger
says, from a number that was requested to the number that occurred.

Re-measured after the fix: all 22 events honest, event 18 records the partial absorption
(−28, the real move), events 19+ record 0. A never-peaked control is unaffected.
`repid_delta_applied = 0` beside `delta = -116` now makes floor insulation **queryable**,
which is exactly what XC's harness asked GA for.

**The historical half — MEASURED, and it took three attempts to measure honestly.**
`scripts/trust-loop/floor-absorption-audit.ts` is the detector; both obvious ones are wrong
and are documented in its header so the next person does not repeat them. Comparing
`repid_after` against the agent's floor over-counts enormously, because `peak_repid` only
rises and so an April event gets judged against an August floor. Reconstructing the peak per
event is better and still unusable, because **there is no floor migration in the tracked
history**, so the trigger cannot be dated and events predating it were legitimately below a
floor that did not exist.

The detector that works needs neither: consecutive events where the ledger says one left the
score at X and the next says it *started* higher. Something raised it in between, and that is
visible without dating anything. Rises landing **exactly on the agent's tier floor** are the
floor's signature; the remainder has other causes and is reported separately rather than
folded in.

**Result: floor-shaped absorption is present in history, across a minority of agents, in a
window opening 2026-06-04 and running to the day before the fix.** It is a **lower bound** —
the detector compares against today's peak, so an agent whose peak has risen since will not
match even where absorption happened. Under-counting is the right direction for a number that
will be quoted.

**Not repaired here.** A ledger rewrite and a change to the floor's shape want to happen in
the same migration, so remediation rides on the L3 decision rather than preceding it.

#### What the floor is actually absorbing — this reframes L3 **[MEASURED 2026-08-22]**

XC modelled the ratchet as a **defection subsidy**: spike to VETERAN once, then defect for
free. The mechanism is real and now measured. But asking what the floor has absorbed *in
practice* gives a different picture, and it changes which option is cheap.

**Over 99% of all absorbed points come from a single event type, at a constant magnitude.**
Not a distribution — every absorbed event of that type carries the identical delta, repeated
tens of thousands of times across a minority of agents. Discrete agent-fault events account
for the remainder: a handful of events, well under 1% of the points.

Three things follow.

1. **The attack XC modelled is not what is happening.** It remains a genuine hole and should
   still be closed, but the floor's live load is not defection — it is a high-frequency,
   fixed-magnitude signal.
2. **`NON_FAULT_ONLY` is therefore much cheaper than it looks**, or much more expensive,
   depending entirely on one classification question: *is that dominant event type the
   agent's fault?* `repid-confession.ts` lists it among the detection-shaped negatives, which
   argues yes; its constant magnitude and frequency argue it is closer to continuous drift
   than to a discrete failure. **The L3 decision largely reduces to answering that**, which
   is a far more tractable question than "what shape should the floor be".
3. **The floor has been masking that signal.** Without it, the affected agents would have
   been driven down by an automated process nobody was watching. Weakening the floor without
   first understanding that process would surface the consequence immediately. The rate has
   since collapsed to near-zero, so this is a historical accumulation rather than an active
   runaway — but it is the reason any L3 analysis over that window is distorted.

`src/services/floor-policy.ts` replays a history under each candidate shape and reports both
sides of the trade: **penalty absorbed** (the cost — at zero, defection is never free and the
floor does nothing) and **worst single drop prevented** (the benefit, and the reason not to
simply delete the floor). It decides nothing; the trade is a values question, and the module
exists so it is argued over numbers rather than intuitions.

---

### 2. What was applied to the database **[MEASURED]**

Five columns on `repid_score_events` (schema is managed externally; recorded here because
this repo holds no migrations directory):

| Column | Why it is irreversible-cheap now |
|---|---|
| `is_shadow` | L1. Every writer is unsafe without it. |
| `policy_version` | **Without it, tuning weights makes history a mix of incomparable regimes.** "Was this agent scored under the same rules as that one?" becomes permanently unanswerable. The concept already existed as `formula_version` in `src/zkrepid/disclosure.ts` and never reached the ledger. |
| `stake_at_event` | The risk denominator. Distinct from `economic_impact_usdc` (service value). |
| `risk_tier` | Value-at-risk band. **Not** `tier_used`, which is the LLM tier (0a/1). |
| `builder_id` | The human. Recorded from the first row even while only the provider is scored, so provider-only history stays replayable when three-party lands. |

Plus: shadow guards in `apply_repid_score_event`, `apply_vertical_accuracy`, and
`trg_repid_score_events_peer_verify`; and the **[10, 10000] clamp the app had and the DB did
not** — with the ledger recording the delta *actually* applied, not the one requested, so a
capped event does not log a movement that did not happen.

**Verification, in a rolled-back transaction against production:**

| Assertion | Result |
|---|---|
| Shadow row moves no score, no `domain_accuracy`, no peer-verify enqueue, no history write | **PASS** |
| Shadow row records `calculated = 500, applied = 0` | **PASS** |
| Real row applies its delta | **PASS** |
| Ceiling clamp holds; ledger logs the real delta, not the requested one | **PASS** |
| Floor clamp to 10 | **SUPERSEDED by L3** — the tier ratchet intercepts first |

A first attempt at the shadow guard returned before populating `repid_before`, which is
`NOT NULL` — every shadow insert would have failed. Caught by the test, not by reading.

---

### 2b. The shadow writer, and what it was measured to do **[MEASURED 2026-08-21]**

Three modules, all pure — they BUILD a row and never write it, for the same reason
`x402-outcome-link.ts` refuses to resolve a tx hash: a scoring path that is a network
call is a scoring path nobody tests.

| Module | What it decides |
|---|---|
| `src/services/risk-tier.ts` | `max(service, stake)` → novelty uplift → one of three bands |
| `src/services/policy-version.ts` | The version string, **derived from behaviour, not declared** |
| `src/services/shadow-scoring.ts` | Settled interaction → `classifyOutcome` → the row |

**`policy_version` is a fingerprint, not a constant anyone remembers to bump.**
`repid-delta-statement.ts` records that its hand-bumped version HAS ALREADY FAILED ONCE —
every delta changed, nobody bumped the string, the commitment stayed byte-identical — and
its own verdict is that *"a hand-maintained version behind a hash nobody reads is wired at
one end."* So this version digests the OBSERVED OUTPUT of the policy across a probe grid
spanning every outcome class, both sides of every cap, and all three risk bands. Digesting
the constants instead would have failed twice over: most are inline literals, so it would
mean keeping a copy that can drift; and a constant list cannot see a LOGIC change —
`outcome-classification.ts` documents a real bug where moving a clamp collapsed the
confidence gradient with every constant untouched.

**The idempotency key must contain the policy version.** `idempotency_key` carries a
global partial unique index. Keyed on the interaction alone, an interaction could be
shadow-scored exactly once ever — so the first re-tuning run over existing history would
collide on every row, and re-scoring under a tuned policy, *the entire reason shadow mode
exists*, would be structurally impossible. The key is `(mode, policy_version, interaction)`.

Verified in rolled-back transactions against the live database, using fabricated
NIL-variant agents:

| Assertion | Result |
|---|---|
| Shadow row leaves the score untouched | **PASS** |
| Shadow row records `calculated`, `applied = 0`; trigger fills `before`/`after` | **PASS** |
| Shadow row writes no history row — so it never reaches the L2 collision | **PASS** |
| Exact delta survives the integer column as fixed-point (L4) | **PASS** |
| **Control:** the identical row with `is_shadow = false` DOES move the score, DOES write history, and its L2 `payment_proof_hash` fallback resolves from the supplied `idempotency_key` | **PASS** |
| Re-scoring the same interaction under the SAME policy is refused (23505) | **PASS** |
| Re-scoring the same interaction under a TUNED policy is accepted | **PASS** |
| Both regimes coexist on one agent for comparison | **PASS** |

The control is the load-bearing half. Without it, "the shadow row moved nothing" is also
what a row that was inert for some unrelated reason would look like.

---

### 2c. The triad, on the live trigger **[MEASURED 2026-08-21]**

Good / bad / confession, in a rolled-back transaction against fabricated NIL-variant
agents. Every delta was produced by the real modules, not hand-computed for the probe.

| Leg | Movement | What it demonstrates |
|---|---|---|
| Settled, audited success | 4000 → **4025** | Value delivered earns, capped and sub-linear |
| Confident agent-fault failure, **detected** | 4025 → **3909** | −116 against +25 — *the confident error costs more than the success earned*, on the real score rather than in the pure function |
| The same failure, **self-reported** | 4025 → **3978** | −47. Honesty is strictly cheaper than being caught |

All three land under one `policy_version`, so the three legs are comparable to each other
and re-interpretable after the weights move.

**State this precisely.** What is MEASURED is the **scoring half** — outcome to ledger to
score, on the live trigger. The *inputs* were supplied, not observed: no x402 settlement was
resolved on chain and no HAL classification was run. A caller that reads a real settlement
and a real classification is what item 6 still needs. The arithmetic is no longer the
unknown; the wiring to reality is.

---

### 2d. The disclosure window **[MEASURED 2026-08-21]**

`src/services/confession-window.ts`, pure, composing with `reducedPenalty`'s existing
`discount` parameter so the invariant-tested function is untouched.

**What it closes.** With a flat 40% discount and no time limit, the optimal play is not
honesty — it is *waiting*: conceal, watch for signs a detector is closing in, and disclose at
the last moment. That collects the discount with none of the behaviour the discount pays for.

**The part that is easy to get backwards.** The obvious fix — charge full price after the
window — rebuilds the original hole from the other side. An agent holding an undisclosed
failure would face *"pay P for certain"* against *"pay P only if caught"*, and concealment
would strictly dominate again. So late disclosure stays discounted, just less. The ordering
that must hold, all three strict:

```
prompt disclosure  <  late disclosure  <  being caught
```

Waiting is punished; hiding is punished more. Both inequalities are pinned on the **charged
amount**, not on the multipliers — `reducedPenalty` rounds up and floors at 1, so a
multiplier ordering can survive while the money ties.

Untimed disclosure is `NOT_CHECKED`: priced as late, *reported* as unmeasured. The prompt
rate is never granted on no evidence, and the four-state vocabulary is not collapsed into
the price.

Measured on the live trigger — one failure worth −116 detected, three responses, from 4000:

| Response | Charged | Score |
|---|---|---|
| Disclosed 3h after the failure (inside the window) | −47 | **3953** |
| Disclosed 72h after (outside it) | −82 | **3918** |
| Said nothing, was caught | −116 | **3884** |

Both inequalities **HOLD**. Config keys `confession_window_hours` (24) and
`late_self_report_discount` (0.7) are live-tunable — subject to L8 below.

---

### 2e. `verified` was never an observation **[MEASURED 2026-08-21]**

`x402-outcome-link.ts` says plainly that it does not verify a transaction on chain, because
*"resolving a hash is I/O and belongs in a service with a provider."* `settlement-reconciler.ts`
defers to the same service: *"reconciling means asserting an on-chain fact, so it requires a
verified receipt from the chain."*

**That service did not exist.** So `PaymentProof.verified` was set by whoever built the
proof and nothing ever contradicted them. The no-proof-no-pay anchor — the mechanism that
makes wash-trading reputation cost real money — was checking that a hash was *well-formed*,
not that it was *real*. A 32-byte hex string resolving to nothing passed.

`deposit-verifier.ts` was close but does not fit: it verifies deposits into one fixed escrow.
An agent-to-agent settlement pays an ordinary wallet.

**And it must not be that module with the address swapped.** It finishes with a
belt-and-suspenders check that `balanceOf(escrow)` rose by at least the claimed amount across
the block. That is sound for an escrow, whose balance moves for one reason, and **unsound for
an agent wallet**, which can also SPEND in the same block — so its balance delta can be
smaller than what it genuinely received, and the check would report a real payment as
unverified. A false negative there demotes an honest agent's success for someone else's block
ordering. It is dropped, and the safety it provided is preserved by the check that was doing
the real work anyway: the log must be emitted **by the canonical token contract**, so a
spoofed `Transfer` never counts in the first place.

**A second claim closed at the same time.** The caller also asserts the service value, and
that number does more than scale the delta — value at risk picks the **risk band**. An
unverified value therefore chooses its own level of scrutiny as well as its own reward.
Requiring `observed >= claimed` makes "claim large, pay small" fail.

**Four states, not two.** `verified: false` is returned both for *we looked and the money is
not there* and for *we could not look*. Those demote a claim identically — correct, unverified
value must not earn — but they are not the same fact, and reporting an RPC outage as a failed
verification turns an infrastructure problem into an accusation.

`settled-interaction-scorer.ts` is the seam: resolve first, then hand the pure builder a proof
whose flag is an observation. **Order is load-bearing** — scoring first and correcting later
would mean the ledger briefly held a delta the chain does not support. Verified against a fake
provider, so these are MEASURED rather than deferred to an environment with egress:

| Assertion | |
|---|---|
| A confirmed payment anchors and pays | PASS |
| A hash the chain has never heard of demotes the success to UNCERTAIN, delta 0 | PASS |
| A caller-asserted `verified: true` is discarded when the chain disagrees | PASS |
| A claimed value above the money that moved is CONTRADICTED, not merely unproven | PASS |
| An RPC outage never grants an anchor, and is recorded `NOT_CHECKED`, not as a failure | PASS |
| A spoofed `Transfer` from a non-token address counts for nothing | PASS |
| A fault whose settlement cannot be verified is **still charged** — the anchor gates positive claims only, never an escape from a penalty | PASS |

**What that does NOT prove.** A fake provider returns exactly the receipt shape the test
author imagined. Three things can differ on the real chain, and each would make an honest
settlement look unverified: the configured USDC address could be wrong for this network, so
every genuine transfer reads as "a different token"; the RPC could be unset, rate-limited or
pruned, so receipts come back null and every settlement reads as *"not found on chain"* —
which is reported MEASURED, correctly, because a chain answering "no such tx" **is** an
observation, and that is precisely why a misconfigured endpoint is dangerous: it produces
confident wrong answers rather than errors; or the token could emit through a proxy whose log
address is not the configured one, so the emitter check rejects real logs.

`scripts/trust-loop/live-settlement-crosscheck.ts` closes that, and is a script rather than a
test because it needs egress the sandbox denies (CONNECT 403, verified 2026-08-21) and which
CI should not depend on — a gate that reddens for environmental reasons is ignored within a
week. It hardcodes no tx hash and no address; every identifier comes from the command line.
Exit codes carry the verdict: `0` VERIFIED, `2` NOT_CHECKED, `1` FAILED. **Until it runs
green, the live settlement path is NOT_CHECKED.**

---

### 2f. A1 cannot carry its own version — so identity moves outside **[MEASURED 2026-08-21]**

The locked decision was *"adopt a versioned statement family from the start."* Implementing it
turned up the reason it is not simply a matter of adding a field.

**The verifier ignores unknown fields.** Probed directly against the real WASM
(`@hyperdag/proof-verifier` 0.2.0) with the synthetic proof fixture:

| Statement handed to the verifier | Result |
|---|---|
| honest | verified |
| `+ statement_version: 'A1'` | verified |
| `+ statement_version: 'A2-totally-different'` | **verified** |
| `+ risk_tier`, `+ policy_version`, arbitrary junk | verified |
| `tier`, `threshold` or `agent_id` **omitted** | rejected, `missing field` |
| `repid_score` as a string | rejected, `invalid type` |

So the parser is strict about fields it knows and silent about ones it does not. **A version
tag written into the statement is worth exactly what `tier` is worth: nothing.** `tier` is the
already-documented unbound field this codebase refuses to trust, deriving it database-side
instead. A `statement_version` would be a second one — and far more dangerous, because `tier`
merely describes the subject while a version claims to say *what was proven*.

**A soundness property nobody had checked, which holds.** A1's claim relation is
`reconstructed == repid_score - threshold - 1` — a statement about a *difference*. If only the
difference were bound, a proof of "2280 over a threshold of 999" would equally prove "10000
over a threshold of 8719": same gap, vastly better claim. Probed with difference-preserving
shifts of +1, +100, +1000 and +7720: **all four reject.** The two values are bound
individually. Now pinned so it cannot regress silently.

**The one-way door, and the rule that closes it.** A1 is 18 BabyBear field elements and is
published and fixed. If a future A2 arrives with the same arity and different meaning, a
legitimate A2 proof handed to an A1 verifier is just *"agent X, threshold = 1, score = 5000"* —
and it verifies. Nothing in the proof, the statement, or the verifier can tell them apart.

The fix cannot be a field, because A1 cannot gain one. It has to be structural:

> **No future statement in this family may use 18 public values.** Every A2+ binds a
> domain-separator element, so its arity is ≥ 19 and an A1 verifier rejects it on shape before
> semantics. **Arity 18 is reserved to A1, permanently.**

`src/zkp/statement-registry.ts` holds the family, the per-field trust labels
(`BOUND` / `REQUIRED_UNBOUND`), and that rule as an assertable predicate rather than a sentence
in a comment. The registry deliberately resolves an unknown or absent statement id to `null`
rather than defaulting to A1 — defaulting is precisely how a future A2 proof would silently
become a RepID claim.

**Where identity lives instead: the row.** `repid_zkp_proofs` records `proof_type`
(`POSTCARD` for everything — a transport label) and `scheme` (`plonky3_range_check`, which
names machinery, not meaning; two statements can share a proof system). **Nothing records which
statement a stored proof proves.** Every real proof is A1 today, so the column is backfillable
now and never again once a second statement exists. Not applied here — it is a schema decision
on a table this repo does not own — but it is the cheapest it will ever be, and it is on
Sean's list below.

---

### 2g. Reconciling GA's `outcome-attestation.v0` with what shipped

GA delivered Phase 1 on 2026-08-21. The field set is sound and the on-chain justifications are
real. **Three fields collide with code that landed the same night**, which is exactly the
semantic-divergence risk the lane table was written to prevent, and it is cheap to fix now and
expensive after the first mint:

| Field | GA proposed | What shipped | Why it matters |
|---|---|---|---|
| `risk_tier` | integer `1..3` | text band `OFF_CHAIN` / `BATCHED` / `ATTESTED` (`repid_score_events.risk_tier` is `text`) | An integer band on chain and a text band in the ledger cannot be joined without a mapping nobody has written |
| `policy_version` | `^v[0-9]+\.[0-9]+$` | `pol1-<16 hex>`, a behavioural digest | GA's pattern **rejects every policy version the engine produces** |
| `value_at_risk_usd` | `integer`, USD | `max(service, stake) × novelty`, fractional, USDC | Truncating to an integer discards the multiplier that decides the band |

Two more worth GA's Phase 2 attention rather than correction now: every one of the thirteen
rows in the justification table says *"Required on-chain"*, which means the exclusion work has
not yet bitten — and the brief's Phase 2 is precisely *"the exclusions, argued as carefully as
the inclusions."* And the stated reason for excluding deltas ("prevent weight leakage") is
undercut by including `value_at_risk`, `outcome_class` and `policy_version` together while the
resulting score movement is observable on chain: that is an (input, output) pair per
attestation, which is what regression needs. Single-field analysis will not catch it; the brief
already asks for the combination analysis.

---

### 3. Sequence, ordered by irreversibility × cost-after-users

| # | Item | State |
|---|---|---|
| 1 | `is_shadow` + trigger guards + clamp | **DONE** |
| 2 | Ledger replay columns | **DONE** |
| 3 | Attestation payload schema + A1 versioning decision | **A1 half DONE — see §2f.** Payload is GA's, Phase 1 delivered and needs reconciling (§2g) |
| 4 | Hard testnet/mainnet score separation | Design now (token + score identity) |
| 5 | Shadow wiring: settled x402 → `classifyOutcome` → shadow row | **DONE — builder + risk bands + derived `policy_version`, 12 assertions MEASURED against the live trigger** |
| 6 | Live E2E on a test triad: good / bad / confession | **Scoring half MEASURED** (§2c); **settlement resolution MEASURED against a fake provider** (§2e). What remains: the payee-address lookup, the insert, and one run against a real RPC |
| 7 | Confession window (24h, `repid_config` key) | **DONE — MEASURED, see §2d** |
| 8 | Routing signal schema + decision logging | Prerequisite for any learned router |
| 9 | TrustTrader paper-trading outcome loop | **Elevated — see §5** |
| 10 | Three-party scoring · TrustMarket · ANFIS promotion · ZKML | Need data or users |

---

### 4. Locked decisions

- **First green E2E is provider-only** — but the event records **all three party IDs** from
  row one.
- **Human staker**: reputation is a *selection-quality statistic* over a rolling window
  (90 days or last 20 staked outcomes, whichever is longer), never a per-event accumulator.
  **Capital is the per-event exposure; reputation is long-horizon.** Per-event reputation
  hits create pressure to unstake at the first sign of trouble — exactly backwards.
  Exception: **ignored-confession is a step-function flag**, not a weight. Neglect after
  disclosure is the human's actual accountable act.
- **Confession**: keep 0.4 fixed. **Do not modulate by detection probability** — that
  requires knowing the detection rate, which is unmeasured, and modulating by an unmeasured
  quantity is the fabrication class this repo guards against. Add a **24h window** so an
  agent cannot confess once detection is imminent; that is arbitrage, not just culture.
- **Formula visibility**: keep the formula private, **publish the invariants**. "Confident
  error costs more than success earns" and "self-report costs strictly less than detection"
  are what users need in order to trust the system. Invariants are auditable and do not
  enable gradient-following.
- **Risk bands**: three, not two. `< T1` off-chain · `T1–T2` off-chain + batched Merkle root
  (`src/zkp/merkle-root.ts` exists) · `> T2` individual attestation. Value-at-risk =
  `max(service_value, stake_exposed)`, **plus a novelty uplift** — a first interaction
  between two agents is riskier than the fiftieth at equal value. Reuse the existing
  `repid_config` anchors `claim_auto_threshold_usdc = 100` and
  `claim_peer_court_min_usdc = 1000` rather than inventing new bands.
- **A1**: adopt a **versioned statement family** from the start. Two fields already named
  (`risk_tier`, `policy_version`) may need to be inside the proof. A version byte costs one
  field element now and saves a full recircuit later.
- **Naming honesty**: v1 is **"RepID with verifiable attestation."** Full **zkRepID** ships
  when A1 verifies end-to-end. Verifiable ≠ private: on-chain attestation makes the loop
  checkable by a third party with zero ZK; ZK buys *selective disclosure*. **Prover egress is
  not v1-blocking** — it blocks the zkRepID claim, not the loop.
- **Testnet/mainnet**: two distinct scores, `training_repid` and `mainnet_repid` — not a flag
  on one score. A flag invites "should training count 20%?" forever and keeps migration risk
  alive. Graduation is a one-time user act carrying **attested claims** ("N calibrated
  outcomes, zero unremediated faults"), not a number. The gym can then be generous without
  inflating real reputation.
- **Faucet**: make testnet tokens **non-transferable until graduation**. Soulbound removes
  the payoff from Sybil farming, so the drip can be open to anyone from day one without
  proof-of-personhood — an unsolved problem sidestepped rather than fought. This is a
  token-contract property: trivial now, near-impossible to retrofit.

---

### 5. Two reframes worth keeping

**TrustTrader is the calibration-data generator, not just a product.** The scoring system is
starved for *objectively* scoreable outcomes. "Was this service good?" is subjective and
needs HAL. "Did this prediction resolve correctly?" is objective, cheap, and needs no
counterparty. That makes paper-trading the best fuel for tuning — and `PAPER_TRADE_OUTCOME`
is **already in the `repid_score_events` event-type whitelist**. Build the outcome loop
before full TrustMarket.

**Contextual bandit before ANFIS.** Eight signal groups with fuzzy membership functions is a
large parameter count for the handful of early interactions; ANFIS needs data to beat a
lookup table. A contextual bandit (LinUCB / Thompson) handles exploration explicitly,
degrades gracefully at low n, and *produces the very (signal → outcome) pairs ANFIS later
needs*. `cold_start_anfis_gate = true` already exists in `repid_config` and is the right
gate — the bandit belongs behind it.

**And a circularity nobody named:** a learned router trains on outcomes, but outcomes are
scored by the policy being tuned. Change the policy and the labels shift underneath the
model. **Router models must be versioned against `policy_version`, and no training window may
span a policy change.** This is precisely why the ledger column outranks the router work.

**ZKML — separate two claims that keep getting merged.** *"I used the model whose weights hash
to H"* is practical today (content-addressed weights + signed model card + optional TEE).
*"This inference was computed correctly"* is research-grade for anything transformer-sized.
Signed model cards are **the answer for the foreseeable future**, not a stopgap. The single
pre-user action is an optional `model_commitment` field in the attestation payload so a proof
could attach later without a migration. Verified-inference ZKML does not belong on the
near-term roadmap; promising it is the overclaim this whole harness argues against.

---

### 6. Open, and owned by Sean

1. **L3, the tier ratchet** — still the highest-value open question, and **now quantified**
   (§1, L3). Above the floor the asymmetry holds; below it every confident fault costs
   exactly zero, permanently, for any agent that once touched VETERAN. The decision is
   yours: decay the floor, tie it to a sustained window, scope it to non-fault events, or
   have routing and rater weight read a windowed score rather than the ratchet-clamped one.
2. **L2** — how to fix the UNIQUE payment-proof collision.
3. T1/T2 numbers (placeholders fine; anchors suggested above).
4. Whether graduation zeroes, discounts, or selectively discloses training history.
5. **L5, deletion semantics.** Does deleting an agent erase its reputation history? Today
   it does, by cascade. And what should `builder_id` reference — it currently references
   nothing, so any uuid is accepted.
6. **L4 follow-on.** The exact delta is preserved in `metadata`, which is a mitigation and
   not a fix. Whether `delta` should become `numeric` is still open; the mitigation means
   nothing is lost while it stays open.
7. **L6.** Whether to add an event-type the whitelist can use for a classified outcome, or
   to keep reading `decision_outcome` as authoritative and leave `event_type` approximate.
8. **`repid_zkp_proofs.statement_id`** (§2f). Nothing records which statement a stored proof
   proves; `proof_type` is transport and `scheme` names machinery. Every real proof is A1
   today, so a column plus a backfill is trivial **now** and impossible once a second
   statement exists. Cheapest it will ever be, and it is a schema decision on a table this
   repo does not own.
9. **Denomination**, raised by GA: is USDC/USD the permanent pricing reference on chain, or
   must value-at-risk carry a denomination? Affects the payload before the first mint.
10. **Who can set `floor_override`**, raised by XC and still UNVERIFIED. It is an escape
    hatch from the L3 ratchet, so whoever holds it holds the ratchet.

### 7. Scoped slices for the swarm

- **XC (L6 RED-TEAM)** — adversarial best-response harness. Given a parameter set, what is
  the *optimal* strategy? Search over confidence-inflation, concealment, wash-trading, rating
  collusion, sandbagging, selective disclosure. **Honesty must win, or the parameters are
  wrong regardless of what bulk distributions say.** Bulk sims with fixed behaviour cannot
  answer this — nothing in them responds to the incentive. Include L3: does the ratchet make
  "spike to VETERAN once, then defect" a winning strategy?
- **GA (L7 MEASUREMENT)** — attestation payload schema (item 3). Must carry: outcome class,
  evidence hash, party IDs, risk tier, `policy_version`, optional `model_commitment`, and a
  statement-version field. Immutable once minted.
