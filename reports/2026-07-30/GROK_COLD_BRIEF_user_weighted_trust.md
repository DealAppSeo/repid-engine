# Cold brief for Grok — user-weighted trust policy
**Date:** 2026-07-30 · **Protocol:** pre-registered, anti-anchoring · **How to use:** paste §1–§4 to Grok. **Do NOT paste §5 until Grok has answered.**

---

## 1. Why you are getting this cold

Under D-054, agreement between Claude and Grok lets Sean proceed without him arbitrating. That rule has a hole: whoever answers second anchors on the first answer, and "concurrence" becomes mutual pattern-matching — two models confidently wrong the same way, which is exactly the Pythagorean Comma veto's warning (CANON P-003).

So this brief borrows **pre-registration** from clinical trials. Claude's positions and confidences are written and sealed in §5 *before* you see them. Answer cold. Then Sean compares. Agreement counts only because it was falsifiable in advance; disagreement tells him precisely where to spend his own judgment.

**What is explicitly wanted from you:** disagreement where you have it, the failure mode nobody named, and a discipline outside computer science that already solved one of these problems. **What is not wanted:** validation, restatement, or a longer version of the proposal. If a position below is wrong, say which and why it fails — a concrete failure scenario beats a critique.

## 2. Context you need (verified state, 2026-07-30)

- **Live and real:** `src/hal/sbfa-consensus.ts` implements stakes-scaled consensus — `StakesLevel` ∈ {low, medium, high, irreversible}, with per-level `ACT_BAR` {.6/.67/.8/.9}, `IGNORANCE_CAP` {.5/.45/.35/.25}, `MIN_CONFIDENCE_TO_ACT` {.4/.5/.6/.7}. These are **global constants**. A HAL cross-provider fact-check quorum is live and now gates reputation events. A participant-rating primitive exists (`src/engine/participant-rating.ts`) enforcing five laws in code: earned-rating gate (an edge requires a verified engagement receipt), ground-truth anchor (execution > quorum > peer-opinion > self-report), rater-reputation weighting, anti-gaming/collusion discount, multi-axis fairness. Its ledger writer is shadow-gated.
- **Not real yet [R]:** ANFIS is shadow-only and starved; treat "ANFIS learns the weights" as roadmap.
- **Empirical result worth your attention:** injected standing rules ("verify before asserting") have failed twice in this project — 2026-07-28 and 2026-07-30 — the second time while the reminder was demonstrably in the agent's context. Diagnosis: advisory (cannot fail), non-contingent (never names the claim), unmeasured (no compliance signal). The fix shipped was an output-auditing hook, not a better reminder.

## 3. The proposal to attack

Sean's thesis: **the agent, not the model, is the durable layer.** A user's priorities — how much truth is worth, at what cost and latency, and when each dominates — live in a portable preference vector owned by the agent and applied identically across Claude / Grok / Gemini / local SLMs. Full spec: `reports/2026-07-30/USER_WEIGHTED_TRUST_POLICY_SPEC_v0.md`. Core moves:

1. Make the SBFA thresholds **per-user** instead of global (user → org → global resolution).
2. Store preferences as **exchange rates** (cents per avoided error, seconds per avoided error, an error "deductible"), never absolute budgets — $20/day is incomparable across users.
3. Elicit by **revealed preference** (offer fast-cheap beside slow-verified; infer the rate from choices), not a settings form.
4. Score participants with a **strictly proper scoring rule** (Brier/log) over stated confidence vs. outcome — because a satisfaction rating *trains sycophancy*, while a proper rule makes agreement-to-please arithmetically costly.
5. Make the score change **policy** (routing, verification depth, gating, abstention), never merely get loaded into a prompt — a rating in context is a distant prior and loses to proximate specifics.
6. Rate **agents→models** (routing signal) and **agent↔user bilaterally** (double-entry: both post an entry, discrepancies are the signal).

## 4. Questions — answer cold, with a confidence 0–1 on each

- **Q1** Is the agent-side preference vector the right locus of control, or should it live in a protocol layer that both agent and model read?
- **Q2** Does a strictly proper scoring rule actually survive contact with users who *want* agreement, or does it relocate sycophancy somewhere subtler?
- **Q3** Are marginal rates of substitution elicitable in practice, or does revealed preference collapse under context/framing effects?
- **Q4** Is agent↔agent rating worth building before there is outcome data to anchor it?
- **Q5** What breaks first at 10k users — the calibration ledger, the elicitation, or the per-user thresholds?
- **Q6** Which discipline outside computer science has already solved user-specific risk thresholds at scale, and what should we steal from it? (Already borrowed: proper scoring rules from forecasting, MRS/deductibles from economics and insurance, double-entry from accounting, pre-registration from clinical trials, threshold-model reasoning from clinical diagnosis.)
- **Q7** What is the failure mode none of the above names?

---

## 5. SEALED — Claude's pre-registered positions (do not reveal until Grok has answered)

| # | Position | Confidence |
|---|---|---|
| 1 | The agent, not the model, should hold the user's preference profile | 0.9 |
| 2 | Satisfaction-style end-of-chat ratings increase sycophancy; only proper scoring rules resist it | 0.85 |
| 3 | Preferences must be stored as exchange rates, not absolute budgets | 0.8 |
| 4 | A rating loaded into context changes behavior far less than one that changes routing/gating | 0.85 |
| 5 | The biggest near-term win is user-specific SBFA thresholds, not new machinery | 0.7 |
| 6 | Agent↔agent rating is lower value than agent→model rating until outcome data anchors it | 0.6 |

**Claude's self-identified weakest links (attack these first):** #6 (lowest confidence — may be backwards if agent↔agent ratings are what make the BFT quorum weights meaningful in the first place); #3 (exchange rates are theoretically clean but may be unelicitable in practice, which would make them a spec that never touches reality); #5 (may be underrating how much the calibration ledger is the true prerequisite, since without outcome data every other component is ungrounded).

## 6. After Grok answers — what Sean does with it

1. Record Grok's answers + confidences **before** revealing §5.
2. Per question: agree / disagree / partial. Disagreement ⇒ escalate to Sean (D-054 rule 1) and log the split.
3. **Log the concurrence itself as a claim with an outcome slot.** Today D-054 is a voting rule with no feedback — nobody records whether a concurrence was later *right*. Adding the outcome column turns it from a vote into a calibration system, and makes both models' agreement earn its weight per claim-class (live-state facts vs. crypto math vs. strategy — expect very different scores across those three).
4. Append the result to `reports/2026-07-30/AGENT_FAILURE_LOG_AND_ANTIFRAGILE_DESIGN.md` whichever way it lands. A concurrence that later proves wrong is the most valuable entry the log can hold.
