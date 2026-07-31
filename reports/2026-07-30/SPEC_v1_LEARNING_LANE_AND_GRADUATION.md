# SPEC v1 — Learning Lane, Graduation & User-Weighted Trust Policy
**Date:** 2026-07-30 · **Author:** CC (integrating Sean's decisions, Grok ×4 rounds, ChatGPT + Gemini blind rounds) · **Status:** NORMATIVE DRAFT for Grok red-team, then build · **Provenance:** every input doc lives in `reports/2026-07-30/` — this spec integrates, it does not restate.

## 0. Preamble — the decisive rule and the honest frame
Literal ungameability is impossible. The engineered target: **manipulation must yield less expected reputation than honest work, and large-scale manipulation must become progressively more detectable.** The system never asks *"how many approved of this agent?"* It asks: *"how much new, independently verifiable evidence exists that this exact version of this agent behaves competently and honestly under conditions it could not predict or manufacture?"*

**The canonical claim (supersedes all prior slogans — incident 002):**
> Reputation can't be bought — only risked. Mock money moves a score only when reputation is staked on the call; it can carry an agent to ESTABLISHED, never to AUTONOMOUS. Unstaked mock activity earns nothing.

## 1. Normative invariants (MUST; each carries an acceptance test in §6)

**I-1 Two typed tracks.** `learning_rep` and `value_rep` are separate fields bound to the ERC-8004 identity. No arithmetic ever moves mass learning→value. Graduation is **admission** (eligibility), never conversion. Both tracks appear on the passport, always together.
**I-2 Exposure is the only earning currency.** Score delta ∝ Z(W)·outcome, W = financial-at-risk (normalized to value caps) + reputation-at-risk (**as a fraction of the agent's current rep**), × verification strength, entering concavely; per-event delta clamped (±9990, shipped). Zero exposure ⇒ zero delta (absence-neutral).
**I-3 Credibility governs uptick and ceiling.** Bühlmann-Straub: Z = W/(W+k), nonparametric EPV/VHM estimators, **negative VHM → Z=0**; k starts at a conservative assumed prior and switches to estimated only past a published data floor; k-source (assumed|estimated) is always published. Threshold-moving W counts **forced-sample or independently-initiated resolutions only**.
**I-4 Ceiling.** `learning_rep` caps at **2,500** (mid-ESTABLISHED). Crossing 999→1000 requires the graduation bar (I-8). AUTONOMOUS (≥5000) is value-track-only.
**I-5 Reputation escrow ("skin").** Any claim that moves Z or counts toward graduation MUST carry non-zero escrow, scaled to stated confidence, above a per-stakes-class **minimum stake floor** (tunable T-4). Reward is capped by the stake posted. Under-staking a high-stakes endorsement is rejected, not discounted.
**I-6 Endorsement binding.** Deltas bind to **endorsements** (claim + confidence + escrow, logged pre-outcome, receipt-chained), never to trades. An endorsement resolves against the market/world outcome regardless of what any user did. No endorsement ⇒ no delta. Contradictory both-sides endorsements on one underlying net to zero + collusion flag.
**I-7 External-resolution floor.** Only outcomes resolved at ≥ the L2 floor (execution / chain / test / independent quorum) enter the calibration ledger that drives policy. User-labeled outcomes live on a separate weak axis that MUST NOT touch routing/gating/thresholds (one-way valve, typed). **Evaluation is never paid by the evaluatee** (hard invariant; the blind-round rejection). Evaluators are scored against resolved outcomes — never against evaluator consensus.
**I-8 Graduation bar (999→1000), all four:** (a) ≥25 independent forced-sample resolutions across ≥3 domains AND ≥3 verifier families; (b) coverage above floor (abstention-to-a-good-Brier fails); (c) calibration (post-stake Brier) above floor with **scored-set composition published**; (d) ≥75% third-party-verified outcomes with verifier-identity diversity. Promotion holdout: evidence after the graduation request doesn't count for that cycle.
**I-9 Multi-axis, hard floors, LCB.** Reputation is a vector (competence, integrity, robustness, outcome, independence, freshness); graduation = ∧ LCB(axis) ≥ floor. Integrity is **blocking**: fabricated receipts / evaluator manipulation / stakes-label gaming block graduation regardless of other axes. All influence metrics use lower confidence bounds.
**I-10 Effective evidence.** N_eff = (Σw)²/Σw² with dependency-cluster caps (same user/operator/model-checkpoint/task-source/community/lineage/timing). Novelty decay: repetition credit → 0. Time: per-identity daily forced-sample caps + log(1+active_days) rate limit — time cannot be parallelized; per-agent W siloed; user-level (Shapley) contribution feeds **user badges/eligibility only**.
**I-11 Version binding.** Scores bind to the agent manifest (model, prompt, tools, permissions, operator — fingerprinted). Material change ⇒ partial reset / re-certification. Identity transfer reverts or burns accrued rep (soulbound binding). New identity ⇒ Z≈0 + rate limits + small irreversible learning-rep burn (whitewash cost).
**I-12 Conduct multipliers (BMS).** The existing `REDEMPTION_MODIFIER` (0.80) and φ-alignment multipliers formalize into discrete bonus-malus conduct levels (<0.9 malus … >1.1 bonus relativities on ACT_BAR / verification depth / routing priority). Transitions are Markov and fire **only on positive resolved coverage — never elapsed time** (RT-2). At high/irreversible stakes only malus transitions are legal (one-way ratchet). Sunset = decaying relativities via the freshness axis, driven by resolved outcomes.
**I-13 Protected stakes classifier + identity strength.** Stakes labels are a protected pure function (conservative default; user may escalate, never de-escalate). Identity strength is a **multiplier on effective W**: unbound identities have W_eff < W; actions classified high/irreversible require 2FA or conservator binding (machinery exists: `requiresConservatorApproval`, `src/engine/mcp.ts`). Global ACT_BAR/MIN_CONFIDENCE floors are inviolable from below by user preference AND by learned policy (shipped for ANFIS as escalate-only, #281/#282).
**I-14 Forced-sample pool (commit-reveal).** Multi-curator independent commitments hash-combined into the epoch Merkle root; threshold VRF seeded **after** root fixation; forced-reveal deadlines with slash; curator eligibility = value-rep ≥ threshold + burn-in + irreversible learning-rep burn; composition statistics published per epoch; automated **composition-divergence tests** (domain balance, verifier-family entropy, difficulty skew) — detection automatic, slash adjudicated (hybrid, per governance separation). Emergency: compromised root ⇒ previous clean epoch; none ⇒ **halt learning-track upticks (fail-closed)**. Cartel EV inequality (Grok): EV ≈ (1−p)G − p·λ·S·B·C − κ(C); with E[slash] ≥ 3G, EV < 0 whenever p ≳ 0.25 — pre-registered acceptance test T-1.
**I-15 Slash proceeds → bounty + subsidized-verification pool.** Every detection funds red-teams and the learning lane's free verification budget (hard per-identity caps — no wealth gate). **Every successful exploit auto-adds a sensor:** a confirmed gaming path becomes a new hard-proxy category in the next epoch root (first-class antifragility clause).
**I-16 Governance separation.** Delegates/QV (expiring, non-transferable, non-purchasable Voice Credits) may change future thresholds, weights, evaluation families. Governance MUST NOT touch an individual agent's score, forgive an incident, pick evaluators for a known case, or reveal private sets. Curators stake rep on pool entries.
**I-17 Fail loud, degrade narrow.** Any component that cannot verify says so and marks output ([R]/degraded); no silent fallback anywhere in the trust path (house rule from incidents 001/002).

## 2. Grok's three tunables — answered (locked pending his red-team)
- **T-1 λ and floor:** base λ = 20% of curator's staked value-rep × blast-radius B, floored so **E[slash] ≥ 3× max mintable G per poisoned epoch**. Confirmed.
- **T-2 target p_detect:** engineer for **≥0.5** — safety factor 2 over the 0.25 EV-negative threshold; re-check sampling rate is derived from this target and published.
- **T-3 composition-divergence test:** **hybrid** — detection fully automatic (flags + provisional weight-throttle), slash requires adjudication (blind, family-disjoint panel), preserving I-16's automated-detection / adjudicated-punishment line.
- **T-4 minimum stake floor & T-5 daily forced-sample cap:** launch placeholders — escrow floor = 2% of current rep at low stakes, 10% at high (scaled by confidence); 5 forced-samples/identity/day. Both tunable; both pre-registered in §6.

## 3. Component map (build ON, never beside)
| Spec element | Existing machinery |
|---|---|
| Z/W credibility, wisdom/conduct multipliers | `reward-formula` call site + `wisdom-normalize` (#274 pattern), `decay.ts` redemption |
| Stakes floors | `sbfa-consensus.ts` ACT_BAR/IGNORANCE_CAP/MIN_CONFIDENCE (→ per-user resolver, floors inviolable) |
| Rating edges, five laws | `participant-rating.ts` + ledger (shadow) |
| Fact-check / verifier quorum, family disjointness, checkpoint dedup | `fact-check.ts` (+ #277 score-event gate) |
| Vesting → learning-track skeleton | `vested_repid` gate (generalize) |
| Escrow/slash primitives | stake-vault + x402 receipts; escrow contract = Phase 3 on-chain |
| Merkle commit-reveal | LeanIMT+/proof-carrying index (P0–P3) |
| Bounded learned authority | `anfis-escalation-gate` (#281/#282) — the pattern I-13 reuses |
| Conservator/2FA | `mcp.ts` conservator gates + agent-gate OTP |

## 4. Build order (each shadow-first with promotion gates)
1. **Calibration ledger** w/ I-7 floor + composition publishing + stated-confidence-required
2. **Coverage co-metric** (ships WITH 1 or 1 trains abstention)
3. **Escrowed endorsements** (I-5/I-6) on the learning track, DB-ledger first (on-chain escrow later)
4. **Protected stakes classifier** (I-13) + identity-strength W multiplier
5. **Credibility engine** (I-3) with assumed-k; per-user threshold resolver (floors inviolable)
6. **Forced-sample pool v1** (I-14: multi-curator commit-reveal, composition stats; HAL quorum as Tier-3 anchor w/ committed sunset)
7. **Graduation state machine** (I-8/I-9) + BMS conduct levels (I-12)
8. **Voice Credits + governance rails** (I-16); Shapley/LOO graduation audits (I-10)
Phase-4 roadmap [R]: PoP uniqueness, ZK reputation predicates beyond range proofs, on-chain escrow, spectral collusion audits.

## 5. Messaging rails (delta only)
Canonical claim per §0. Retired: the blanket "mock money earns zero reputation." Everything else per `SPEC_AMENDMENTS_v0.1_and_MESSAGING.md` with its do-not-say list unchanged.

## 6. Pre-registered acceptance tests (red-team targets)
- **A-1 (T-1/I-14):** simulated curator cartel at p=0.25, 0.5: long-run EV < 0 across cartel sizes; publish the engineered p.
- **A-2 (I-2/I-5):** min-confidence grinding sim: expected value of low-confidence volume ≤ 0 post-stake; property test across confidence grid.
- **A-3 (I-8):** colluding-verifier sim: cost of meeting the 75% bar dishonestly > honest cost under verifier stakes/rotation/re-checks.
- **A-4 (I-1):** no code path moves learning→value (type-level + property test).
- **A-5 (I-10):** 10,000 one-day sybils accrue less than one 30-day agent (rate-limit property).
- **A-6 (I-12):** no BMS bonus transition fires from elapsed time alone (absence-neutrality property).
- **A-7 (I-13):** no input combination lowers effective floors below globals (mirror of the shipped escalate-only property test).
- **A-8 (I-7):** user-labeled outcomes cannot reach routing (type-level valve test).
- **A-9 (baseline):** with no preference vector and no learning lane, engine behavior is byte-identical to today (regression property).

## 7. Open items carried
Curator-cartel formal analysis at chosen constants (A-1 executes it) · verifier fee sizing (x402 denominated, set with first organic verifiers) · exact BMS level table (from redemption/alignment constants, own doc) · Grok red-team of this spec (next), then v1.1 locks.
