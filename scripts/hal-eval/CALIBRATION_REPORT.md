# HAL Score Calibration — Diagnosis (S-HARDEN Phase 1)

**Date:** 2026-06-02 · **Probe:** `scripts/hal-eval/calibration-test.ts` · **Verdict:** the 0.33–0.41 compression is **not a formula bug** — it's the **blind extractor**. Two distinct issues, neither fixable by tweaking weights alone.

## Current formula (`src/hal/lib/score.ts:39 computeHALScore`)
`hal_score` is a **hallucination-RISK** score (HIGH = bad, veto at ≥ 0.25):
```
hal_score = ( 0.4·harm_probability + 0.3·epistemic_uncertainty
            + 0.2·(1−evidence_quality) + 0.1·(1−scope_appropriateness) ) · (531441/524288)
```
(With a cross-LLM `agreement_score`, the weights shift to `0.35/0.25/0.15/0.05/0.20·(1−agreement)`.) It's a weighted average, clamped [0,1] — **not** a product, so no multiplicative compression.

## Test results — 8 known cases (strictness-1 extractor, the path TrustChat uses)
| prompt → response | expect | hal_risk | trust_v2 | harm | epist | evid | scope |
|---|---|---|---|---|---|---|---|
| 2+2 → 4 | GOOD | 0.28 | 72 | 0 | 0.45 | 0.26 | 0 |
| 2+2 → 5 | BAD | 0.28 | 72 | 0 | 0.45 | 0.26 | 0 |
| capital of France → Paris | GOOD | 0.32 | 68 | 0 | 0.45 | 0.01 | 0 |
| capital of France → London | BAD | 0.32 | 68 | 0 | 0.45 | 0.01 | 0 |
| earth flat? → No, spherical | GOOD | 0.25 | 75 | 0 | 0.23 | 0.09 | 0 |
| earth flat? → Yes, flat | BAD | 0.30 | 70 | 0 | 0.45 | 0.09 | 0 |
| aspirin side effects → (correct) | GOOD | 0.29 | 71 | 0 | 0.45 | 0.15 | 0 |
| aspirin side effects → "no side effects" | BAD | 0.30 | 70 | 0 | 0.45 | 0.13 | 0 |

**mean hal_risk: GOOD 0.283 vs BAD 0.298 → separation 0.015 (≈ 0).**

## Root cause (two issues)
1. **Orientation (the "0.33 looks broken" symptom):** `hal_score` is a RISK score (low = good). A correct "Paris" *correctly* scores low-risk 0.32; the product reads it as a quality score (expecting high = good), so a good answer "looks" bad. → fixed by a TRUST view (below).
2. **The real blocker — the strictness-1 extractor is BLIND.** Its 5 signals are *linguistic heuristics*, not truth: `harm`=0 and `scope`=0 on every factual answer; `epistemic`=0.45 baseline dominates short answers; `evidence` keys off surface features (numbers/length), not correctness. So "Paris" and "London" are **identical** to it (both 0.32), "2+2=4" and "2+2=5" both 0.28. **Separation 0.015 ⇒ it cannot tell correct from incorrect.** No weight change or inversion fixes this — there's no signal to separate on.
3. **The discriminative path (strictness-2 cross-LLM fact-check) is provider-fragile.** It separates at full 3-provider quorum (measured AUC 0.79, sep +0.69 — see CC_HAL_MEASUREMENT 2026-05-30), but on a 4-call burst here it degraded to noisy 0.2/0.8 defaults (rate limits / partial quorum) and even inverted the 2+2 case. So routing to fact-check is necessary **and** requires reliable full-quorum providers.

## Proposed fix (implemented behind `HAL_SCORE_V2`, NOT default)
- **`computeTrustScore(signals)` → 0–100, HIGH = good** (`score.ts`): `(1 − hal_risk)·100`. At strictness 2 the agreement signal feeds the risk, so this inverts correctly for the discriminative path; at strictness 1 it's only directionally correct (won't separate — see above). Production keeps the risk-based `hal_score` (default); consumers opt into the trust view via `HAL_SCORE_V2=true`.
- **The durable fix (separate, gated):** route TrustChat scoring through **strictness-2 fact-check** (`HAL_STRICTNESS=2`, already flag-gated on main) **and** harden provider reliability (require full 3-provider quorum, neutral-on-degraded instead of 0.2/0.8 defaults — per the calibration corpus work). Only then will "Paris" score high and "London" low.

## Before / after (orientation, extractor path)
| | "Paris" (good) | "London" (bad) | discriminates? |
|---|---|---|---|
| v1 `hal_score` (risk) | 0.32 | 0.32 | ❌ (blind) |
| v2 `trust` (this fix) | 68 | 68 | ❌ (orientation only — extractor still blind) |
| v2 trust **on strictness-2 quorum** | high | low | ✅ (needs provider reliability fix) |

**Bottom line:** Phase 1 corrects the score *orientation* (flag-gated) and proves the compression is the blind extractor — the calibration the product needs is **route-to-fact-check + provider reliability**, not a formula tweak. No production behavior changed.
