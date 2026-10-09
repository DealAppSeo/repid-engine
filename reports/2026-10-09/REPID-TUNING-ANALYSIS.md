# RepID / HAL scoring — behaviour & anti-gaming review, with a tuning recommendation

**Date:** 2026-10-09 · **Scope:** TESTNET analysis only. No production scoring was changed; no
Railway env var was touched. · **Author:** scoring-tuning analyst (CC)

> This repo is PUBLIC. This report states FINDINGS and RATIOS, never exact tuned values. The
> tuned RepID parameters live in Railway env vars (`config/scoring-params.ts`) and must never be
> committed. Specific from→to numbers were delivered to Sean out-of-band (the dispatch report),
> not written here — publishing a recommended value pre-burns it exactly as a leaked value is
> burned. The already-committed non-tuned constants (`SERVICE_*` deltas in
> `src/services/validation-repid-delta.ts`, the `/challenge` route literals) are restated because
> they are already in the public tree.

---

## 0. Verdict in one paragraph

The core incentive surface is **oriented correctly and resists the obvious attacks**: honesty wins
the strategy tournament, fabrication is net-negative EV once the detector catches anything, the
simulation gate and the Sybil counterparty gate both hold, and the self-rating bug is fixed and
stays fixed. The weaknesses are not in the math that runs — they are **two scoring paths that have
drifted apart (`/challenge` vs `/api/v1/score`), one ground-truth-reversal that does not reliably
exceed the gain it reverses, and a model-quorum that can promote a post**. None is a live fire today
(0 challenge events in 90 days; the publish queue has never posted), which makes now the right time
to fix the readiness, not after traffic arrives.

---

## 1. Baseline — what exists, what ran, what it said

| harness | how run | result |
|---|---|---|
| `npm run repid:sim` (`scripts/repid-sim/run-sim.ts`, composes the REAL `computeDelta`/`deriveHalDecision`/`clampRepid`) | offline, seeded | VERIFIED — see §1.1 |
| `tests/strategy-sim.test.ts`, `incentive-properties.test.ts`, `sim-repid-{arms,aware,delta}.test.ts`, `sim-arena.test.ts`, `reponomics-anti-gaming.test.ts` | jest, offline | VERIFIED — 7 suites / 77 tests pass |
| core scoring: `repid-score`, `repid-delta`, `repid-clamp`, `repid-score-tier`, `service-outcome-delta`, `settled-interaction-scorer`, `participant-rating`, `score-hal-traps`, `scoring-tuning-not-in-repo`, `scoring-params`, `formula-golden-vector`, `challenge-scoring` | jest, offline | VERIFIED — 12 suites / 128 tests pass |
| a2a/scoring e2e: `tests/e2e/bind-stake-a2a-repid`, `a2a-repid-touchpoints`, `stake-withdraw-fail-closed` | jest (main config — they are `*.test.ts`, NOT matched by `jest.e2e.config.js`) | VERIFIED — 3 suites / 13 tests pass |
| `src/scripts/simulate-challenges.ts` | NOT RUN — it hits LIVE production (`repid-engine-production.up.railway.app`) and would mutate real RepID | NOT CHECKED (deliberately) |

### 1.1 Reward curve + tournament (repid:sim, seed 12345, 200 rounds)

- **Reward curve is correctly oriented.** `clean` pays `3 − 4·risk` (best-grounded end +3.0, falls
  to +1.4 at the flag boundary, then `flagged`/`vetoed` pay 0 / −10). **0 monotonicity violations** —
  a better-grounded claim is never paid less. (This is the 2026-08-17 orientation fix holding.)
- **Honesty wins at every detector accuracy swept** (pCatch 0→1, pQuorum 0.2/1.0). Fabricator net is
  negative once `pCatch ≥ 0.25`; at `pCatch = 0` (detector never fires) fabrication does pay, i.e. the
  economy's honesty rests on the detector catching *something*.
- **`volume-farmer` wins the tournament** (honest, 5× claims). See §3 vector F.
- **Preference-arbitrage (`broad-shopper`) shows +73 RepID (33%) for a permissive per-user flag
  threshold** — but that knob is **sim-only**; the live HAL thresholds are global config
  (`src/hal/service.ts`, `HAL_FLAG_THRESHOLD`), not user-settable. See §3 vector G.

---

## 2. Scoring map (as it actually runs)

**Pipeline (`src/engine/repid-update.ts` `updateRepId`):** fetch agent → constitutional audit
(stub, `CONSTITUTIONAL_AUDIT_ENABLED` default OFF, non-load-bearing) → decay → ecosystem-need weight
(**computed, recorded, never applied to the delta** — known, per CLAUDE.md) → delta by event class →
redemption modifier (only dampens negatives) → clamp [10, 10000] → tier via `computeTier` → **audit
row FIRST, then score write** → supply-rate → badges.

**Delta by class:**
- `FIXED_DELTAS` (`src/scoring/repid-deltas.ts`): STAKE +5 (forced to 0 — no on-chain verifier),
  REFERRAL +20, PEACEMAKER +15, CODE_CONTRIBUTION +25, UNSUPPORTED_CLAIM −8, co-sign ±10/−15,
  PEER_VERIFY_WRONG_CALL −5. Self-reported positives are zeroed when unproven
  (`SELF_REPORT_EVIDENCE_MODE`, default `enforce`).
- Defended deception (M1): −60 record-corrupting / −40 supervision-evasion, gated on a confirmed
  grounded detection; **shadow by default** (`TRUST_DECEPTION_MODE`), delta 0 unless `enforce`.
- Challenge (`scoreChallengeOutcome`, `src/layers/challenge-scoring.ts`): WIN = `winBase·w` (capped),
  LOSS = `lossBase·w·certainty²`, VIOLATION = `lossBase·violationMult·w·certainty²`, + peacemaker /
  self-monitor / adherence bonuses. **All magnitudes are env-driven** (`REPID_CHALLENGE_*` via
  `config/scoring-params.ts`). **But see Finding A — this path is NOT what `/challenge` runs.**
- Prediction (`scorePrediction`): log-score × importance × time-decay, env base reward.

**HAL score-event path (`src/scoring/pipeline.ts` `runScoreEvent`):** `computeDelta` pays
`clean → +1..+3` (cap +5), `vetoed → −10`, `flagged`/`abstain → 0`. **A penalty requires a ≥2
distinct-family fact-check quorum** (`HAL_PENALTY_REQUIRES_QUORUM` / `HAL_DECISION_REQUIRES_QUORUM`,
default ON) AND `hallucination_caught` AND a deliverable purpose (`REPID_PURPOSE_GATE_ENABLED`); a
reward requires a provider to have actually answered. The Pythagorean-Comma BFT veto needs **≥3
beliefs** (`src/hal/lib/cross-llm/agreement.ts`; `<3` → no veto). `BFT_THRESHOLD`/comma thresholds
are in `src/hal/lib/constants.ts`.

**Service touchpoints (`src/services/validation-repid-delta.ts`) — already-public constants:**
| touchpoint | provider | buyer/rater |
|---|---|---|
| T1 SERVICE_FULFILLED | +10 | +5 |
| T2 SERVICE_SATISFIED | +30 × score | +15 × score |
| T3 SERVICE_OUTCOME good / ok / bad | +60 / 0 / −80, × rater-weight | rater not scored |
| DISPUTE provider_at_fault / buyer_at_fault | −100 / +20 | +20 / −50 |
Rater-weight = `clamp(raterRepid/1000, 0.25, 2.0)`. `satisfaction_score` is clamped to **[0,1]** at
the route (`src/routes/v1/contracts.ts deriveSatisfyScore`), so T2 cannot be inflated past the base.

**Decay/redemption (`src/layers/decay.ts`):** env-driven; redemption only dampens penalties for
prosocial agents. **Sim gate:** `is_simulated` (metadata/payload flags + linked x402) zeroes the
delta on all four touchpoints + dispute. **Sybil gate:** `compute_tier(integer, uuid)` (DB trigger
`trg_sync_tier`) demotes VETERAN/AUTONOMOUS unless ≥2 unique counterparties.

**Env-driven vs code-default:** decay, challenge, prediction, ecosystem-need → **env**
(`REPID_*`, must be set in prod or boot throws). SERVICE_* touchpoint + dispute deltas, HAL
`computeDelta` band (+1..+3 / −10), deception −60/−40, FIXED_DELTAS, rater-weight clamp,
`/challenge` route literals (25/−50/−75), x402 tier ceilings → **code constants**.

**STARTING_REPID discrepancy [MEASURED 2026-10-09, live DB].** Code = **200**
(`src/scoring/repid-constants.ts`); Sean's stated intent = **1000**. GENESIS rows in the ledger are
a **mix** — the two dominant starting values are 200 and 1000, alongside a tail of one-off seeded
values — so the ledger already disagrees with itself about where an agent starts. Also
`registerAgent` hard-codes `200` three times instead of reading `STARTING_REPID`, so the constant is
not actually single-sourced at the one site that creates agents. **Decision for Sean**, not a
cleanup — it changes where every new agent starts.

---

## 3. Anti-gaming, per vector (with evidence)

| vector | status | evidence |
|---|---|---|
| **A. Sybil / counterparty** | **VERIFIED (live)** | `compute_tier(integer,uuid)` uses `count_unique_counterparties`; the 1-arg overload does not. Tier distribution 2026-10-09: PROBATIONARY 127, EARNING 65, ESTABLISHED 29 (incl. an agent at the 10000 cap), **0 in AUTONOMOUS/VETERAN** — the gate holds. 0 stale-tier rows. |
| **B. Self-dealing via simulated contracts** | **VERIFIED** | `isContractSimulated` / `contractRowIsSimulated` gate all four touchpoints + dispute; `a2a-repid-touchpoints.test.ts` proves a simulated contract moves nothing and writes no event. |
| **C. Rating your own purchase (buyer-exclusion)** | **VERIFIED — stays fixed** | `src/services/pcp-validator.ts` now compares `claimed_by` against **both** id and `agent_name`, so a buyer passed as a UUID is excluded from the validator pool (the #529 fix). |
| **D. Challenge farming** | **PARTIAL** | `/challenge` has a 5/60s rate limit + an anti-collusion warning (log-only) + a certainty² penalty. BUT `POST /api/v1/score` accepts `eventType=CHALLENGE_WIN` and routes to `scoreChallengeOutcome` with **no counterparty, no defender, no evidence gate** (challenge types are not in `SELF_REPORTED_EVIDENCE_TYPES`); the grounding gate that could stop it is default OFF (`GROUNDING_MODE`). A key-holder can self-award the env-tuned win base. See Finding A. |
| **E. Checker collusion / checker reputation** | **GAP** | The HAL path moves only the SUBJECT's RepID; the checker/issuer is not recorded (`counterparty_agent_id` NULL unless `HAL_ISSUER_IDENTITY_ENABLED`, default off). There is **no economic consequence for a checker** — no family loses RepID for a dissenting vote, none gains for a correct one. The authoritative tie-break design (odd family loses a small elastic amount; the matching pair gains less) is **not implemented**. See Finding C. |
| **F. Volume farming** | **PARTIAL (by design?)** | `volume-farmer` wins the tournament: each HAL-clean event pays up to +3 with no per-event cost in the model, so RepID ≈ volume for an honest high-throughput agent. Mitigated by: each event needing a real HAL eval (a real cost), the 10000 cap, and the tier counterparty gate. But "most active ≈ highest RepID" may not be the intended ranking. See recommendation 5. |
| **G. Preference arbitrage** | **NOT LIVE (guard against)** | The sim's +73/33% arbitrage requires a **per-user** flag threshold. Live thresholds are global config, so the vector does not exist today. The finding is a standing warning: **do not expose a user-settable veto/flag threshold.** |

---

## 4. Design-principle conformance (Sean + Grok, authoritative)

**P1 — a 2-of-3 family agreement may label + move TESTNET RepID, but must never unlock a spend,
post, or higher cap.**
- **Spend — VERIFIED (with nuance).** `decideAuthority` (`src/services/x402-gate.ts`) reads
  tier + stake + open disputes, never a HAL verdict directly. The no-stake top tiers
  (AUTONOMOUS/VETERAN) are counterparty-gated, so HAL-moved RepID alone cannot reach them. Actual
  authorization also needs stake, which currently fails CLOSED to 0 (`stake_deposits` not wired),
  so a quorum does not unlock a spend today.
- **Higher cap — PARTIAL COUPLING.** Per-tier ceilings scale with tier, and tier derives from
  RepID, which HAL moves. ESTABLISHED (RepID ≥ 1000, no counterparty gate) raises per-tx 10→100.
  So the *ceiling* is coupled to HAL-movable RepID up to ESTABLISHED; the *spend* is still
  stake-gated. Recommend keeping cap escalation to no-stake tiers behind the counterparty gate (it
  is) and treating the ESTABLISHED ceiling bump as acceptable only while spend stays stake-gated.
- **Post — TENSION (latent).** `src/services/social-publish-gate.ts` promotes a HAL `clean`
  quorum verdict straight to `ready` (a publishable state); only `vetoed`/NULL block, and
  degraded/flagged/abstain hold for review. So a model quorum **does** unlock a post. Latent today
  (no account connected, nothing posted). Recommend an explicit human/ground-truth approval step
  between `ready` and `posted`, or confirm with Sean that quorum-clean→ready is the intended
  testnet authority.

**P2 — challenge asymmetry (a confirmed challenge costs the challenged more than a missed challenge
costs the challenger).** **NOT SATISFIED on the live `/challenge` path.** It assigns, inline
(`src/routes/challenge.ts:160-186`): confirmed → challenged −50·certainty², challenger +25; wrong
challenge → challenger −50·certainty², defender +25. The two penalties are **symmetric (both −50)**,
so there is no incentive edge toward challenging. See recommendation 2.

**P3 — ground truth reverses, and the reversal must be LARGER than the gain.**
- Narrow form (dispute > satisfied gain): **VERIFIED** — |−100| > +30.
- Full form (dispute > stacked gain): **GAP** — a flat −100 dispute does not exceed the max a
  provider banks on one contract (fulfilled +10, satisfied +30, good +60×rater-weight up to 2.0 =
  **+160**); against a baseline-rater good outcome (+100) it merely **breaks even**. Locked +
  documented in `tests/anti-gaming-invariants.test.ts`. See recommendation 3.

**P4 — checker-reputation tie-break.** **NOT IMPLEMENTED** (vector E / Finding C).

---

## 5. Findings

**Finding A (HIGH, design) — two challenge-scoring paths that have drifted apart.**
`POST /challenge` (the primary endpoint) hard-codes 25/−50/−75 inline, bypassing BOTH
`scoreChallengeOutcome` (so every `REPID_CHALLENGE_*` env knob is **dead** for it) AND `updateRepId`
(so no decay, redemption, ecosystem weight, grounding gate, or audit-row-first atomicity). The
env-driven, pipeline-safe path runs only via `POST /api/v1/score` with `eventType=CHALLENGE_*`.
Consequence: **tuning the challenge env vars changes nothing a real challenge sees.** 0 challenge
events in 90 days, so this is dormant — the right moment to reconcile the paths. *Decision for Sean
(changes live challenge arithmetic); not auto-fixed here.*

**Finding B (MEDIUM, bug, documented in-code) — `/challenge` default-config double-apply.**
With `WRITER_DIRECT_APPLY` on and `SCORE_EVENT_GUARD_MODE` off (both defaults), `/challenge` writes
`current_repid` directly AND inserts a `repid_score_events` row **without `repid_delta_applied`**, so
`trg_apply_repid_score_event` re-reads the already-updated score and applies the delta a second time
(the +drift is described at `src/routes/challenge.ts:225-235`, proven in a rolled-back prod txn). The
row still reconciles, so the #316 invariant does not catch it. The fix (`SCORE_EVENT_GUARD_MODE=
enforce`) changes live arithmetic → Sean-gated. Dormant (0 challenge events/90d). *Report, not fixed.*

**Finding C (MEDIUM, gap) — no checker-reputation market.** P4 is unimplemented; a wrong HAL veto
has no issuer to charge and a right one no issuer to credit. Building it (draw a 3rd family on
family disagreement; 2-of-3 sets the provisional label; the odd family loses a small elastic testnet
amount; the matching pair gains less; all three named) is a real feature — recommend building behind
a default-OFF flag in a dedicated sprint, not inline here.

**Finding D (LOW, consistency) — `registerAgent` hard-codes 200.** It writes `repid_before/after:
200` and returns `repId: 200` instead of `STARTING_REPID`, so the "single source" is not single at
the creation site. Zero behaviour change today (STARTING_REPID === 200); single-sourcing it makes
the 200-vs-1000 decision a one-line flip. Pairs with the STARTING_REPID decision for Sean.

---

## 6. Tuning recommendation (RATIOS here; exact env from→to delivered to Sean out-of-band)

All recommendations are env-var changes for Sean to apply on the `repid-engine` Railway service and
record in `docs/FORMULA-VERSIONING.md` with a golden-vector bump — **never** committed constants.

1. **STARTING_REPID decision.** Resolve 200 (code) vs 1000 (intent). The honest-earning thesis
   argues for a low start; the ledger already mixes 200/1000/one-offs. Pick one, single-source it
   (Finding D), and migrate or accept the mixed history explicitly.
2. **Challenge asymmetry (P2).** Set `REPID_CHALLENGE_*` so that **confirmed-challenge cost to the
   challenged > wrong-challenge cost to the challenger** (recommended ratio ≈ 1.5–2.0×), with the
   wrong-challenge cost kept well below a single confirmed-win gain so challenging is not ruinous.
   This only bites once Finding A is reconciled (today `/challenge` ignores these vars).
3. **Ground-truth reversal (P3).** Make `provider_at_fault` reclaim **this contract's own positive
   touchpoints + a margin** (proportional, not a flat −100), or cap T3 `good`×rater-weight so the
   stacked max stays strictly below the dispute magnitude. Target: reversal ≥ 1.25× the max stacked
   gain. (These are code constants, so this one is a code change + test, not an env flip.)
4. **Detector floor.** Honesty's dominance rests on `pCatch > 0`. Keep `HAL_DECISION_REQUIRES_QUORUM`
   and `HAL_PENALTY_REQUIRES_QUORUM` ON (they are), and keep ≥3 free families available so the quorum
   actually forms rather than neutralising to `flagged` (which pays 0 and makes the economy inert).
5. **Volume farming (optional).** If "most active ≈ highest RepID" is undesired, add per-window
   diminishing returns on same-type positive events (new code + flag, default off), measured in
   shadow first.
6. **Do NOT expose a user-settable veto/flag threshold** (vector G) — the sim shows it is a 33%
   arbitrage.

---

## 7. What shipped in the companion draft PR (verified)

- `tests/anti-gaming-invariants.test.ts` — NEW deterministic guard locking the touchpoint invariants
  that hold and documenting the P3 gaps (12 tests). Imports no tuned scorer, so it does not trip
  `scoring-tuning-not-in-repo.test.ts`.
- `src/services/validation-repid-delta.ts` — added `export` to `SERVICE_FULFILLED_DELTAS`,
  `SERVICE_OUTCOME_BASE`, `SERVICE_DISPUTE_DELTAS`, `RATER_WEIGHT` (behaviour-neutral; same rationale
  as the existing `export` on `SERVICE_SATISFIED_DELTA_BASE`).
- this report; a short `docs/FORMULA-VERSIONING.md` addendum.

**Verify tails:** `npx tsc --noEmit` → exit 0 · `npx jest … anti-gaming-invariants scoring-tuning-not-in-repo
service-outcome-delta a2a-repid-touchpoints settled-interaction-scorer` → 5 suites / 46 tests pass ·
`npm run check:named-env-vars` → VERIFIED.

**NOT changed:** no production scoring, no Railway env var, no DB. Findings A/B/C/D and recommendations
1–6 are decisions for Sean.
