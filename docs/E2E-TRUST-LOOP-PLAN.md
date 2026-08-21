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

Related drift: CLAUDE.md documents `compute_tier(integer)`. It is now
`compute_tier(integer, uuid)`. The verification command in CLAUDE.md no longer resolves.

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

### 3. Sequence, ordered by irreversibility × cost-after-users

| # | Item | State |
|---|---|---|
| 1 | `is_shadow` + trigger guards + clamp | **DONE** |
| 2 | Ledger replay columns | **DONE** |
| 3 | Attestation payload schema + A1 versioning decision | **NEXT — design only, one-way door** |
| 4 | Hard testnet/mainnet score separation | Design now (token + score identity) |
| 5 | Shadow wiring: settled x402 → `classifyOutcome` → shadow row | Now safe. Must supply `idempotency_key` (L2) |
| 6 | Live E2E on a test triad: good / bad / confession | The headline win |
| 7 | Confession window (24h, `repid_config` key) | Meaningless until 6 produces confessions |
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

1. **L3, the tier ratchet** — highest-value open question on this track.
2. **L2** — how to fix the UNIQUE payment-proof collision.
3. T1/T2 numbers (placeholders fine; anchors suggested above).
4. Whether graduation zeroes, discounts, or selectively discloses training history.

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
