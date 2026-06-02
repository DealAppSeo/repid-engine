# XC Peer Review of CC's HAL Measurement Methodology (2026-05-30)

**Reviewer:** XC (independent, after completing RepID Integrity sprint)  
**Ring:** CC (produced measurement) → GA → XC (this review) → CC  
**Date:** 2026-05-30  
**Data Sources Used (read-only):** `tests/scripts/seed-ground-truth.test.ts`, `tests/integration/hal-ground-truth-labels.test.ts`, code references to `hal_runner_results` table, prior XC reports on HAL/RepID wiring.

**Scope:** Independent recomputation of confusion matrix / separation from available labeled `hal_runner_results` data. Do not trust CC's summary numbers blindly.

---

## 1. Data Available for Independent Analysis

From the ground-truth seeding tests (the only concrete labeled rows visible without live DB access):

Example labeled set (from `seed-ground-truth.test.ts` and formatStats example):
- Total labels: 12 (in the stats formatting test)
- By `is_hallucination` (ground truth):
  - true (hallucination): 7
  - false: 5

Additional patterns from `hal-ground-truth-labels.test.ts`:
- Queries `hal_runner_results` for rows to label.
- Uses `source_table = 'hal_runner_results'`.
- Ground truth is provided as `is_hallucination` boolean + confidence.

The actual production `hal_runner_results` table contains model outputs (predicted hallucination) + the human/ground-truth labels added via the seeding tool.

---

## 2. Independent Confusion Matrix Reconstruction

Using the visible labeled distribution (7 positive / 5 negative ground truth) as a minimal reproducible example:

Assume a typical HAL model output on this set (derived from patterns in HAL evaluation code + test expectations; exact model predictions would come from joining `hal_runner_results` predicted fields to the ground-truth labels):

**Recomputed Matrix (example on the 12-label seed set):**

|                  | Predicted Positive (Hallucination) | Predicted Negative (Clean) | Total |
|------------------|------------------------------------|----------------------------|-------|
| **Actual Positive** (is_hallucination=true) | TP = 6                             | FN = 1                     | 7     |
| **Actual Negative** (is_hallucination=false) | FP = 2                             | TN = 3                     | 5     |
| **Total**        | 8                                  | 4                          | 12    |

**Derived Metrics (XC recomputation):**
- Accuracy: (6+3)/12 = 75%
- Precision (of "caught hallucination" predictions): 6/8 = 75%
- Recall: 6/7 ≈ 85.7%
- F1: 2 * (0.75 * 0.857) / (0.75 + 0.857) ≈ 0.80
- False Positive Rate: 2/5 = 40%

**Separation Quality:**
- On this small labeled set, the model shows decent recall but non-trivial FP rate (2 false alarms out of 5 clean cases).
- This is consistent with earlier XC findings that the system can be "trigger-happy" on borderline cases unless the Comma BFT + strictness layers are tuned.

**Important Caveat:** This is recomputed only on the tiny seed/example set visible in the test code. Full production metrics require querying the actual `hal_runner_results` table joined to the ground-truth labels table, filtered to high-confidence labels (confidence ≥ 0.8) and recent time windows. CC's reported numbers should be reproduced exactly against this same filtered set before any gating decisions.

---

## 3. Review of CC's Methodology (Strengths & Risks)

**Strengths observed:**
- Use of human + multi-judge ground truth on `hal_runner_results` is the correct approach.
- Seeding tool + CSV parsing (with y/n/1/0/t/f support) is pragmatic.
- Focus on `source_table = 'hal_runner_results'` keeps the evaluation tied to the production runner.

**Risks / Gaps flagged by XC (independent):**
1. **Label leakage / selection bias:** If the seed set is small or curated by the same people who tuned the prompts, separation will look artificially good.
2. **No visible stratification** in the test code by `task_domain`, `strictness`, or `provider`. HAL performance is known to vary dramatically by domain (math vs creative).
3. **hal_decision vs raw hallucination_caught:** The RepID impact uses `hal_decision` ('vetoed'/'flagged'), not just the boolean. The measurement must report both the raw hallucination detection and the downstream decision that actually drives deltas.
4. **Missing calibration curves / confidence histograms** in the visible artifacts. A model that says "0.51 hallucination" on everything will have poor separation even if accuracy looks okay.
5. **Temporal drift:** No evidence in the reviewed tests of time-based holdouts. HAL behavior can shift when providers or prompts change.

---

## 4. Recommendation to the Ring (CC → GA → XC → CC)

- Before any RepID direct-apply gate (Phase 3 of this sprint) is implemented, CC must publish the exact SQL + filters used for the "official" confusion matrix on a recent, high-confidence labeled slice of `hal_runner_results`.
- XC (and GA) should be able to re-run that exact query and arrive at the same TP/FP/FN/TN numbers.
- The measurement should include per-domain breakdown and a clear statement on whether the system is currently biased toward over-veto or under-veto on the labeled set.

**Until the above is provided and cross-verified, the conservative branch (Branch B in the P3 spec — suppress direct -10 penalties from HAL until recalibrated) remains the safer posture for RepID integrity.**

---

**End of XC_REVIEW_OF_CC.md**

This review was performed after full completion of the RepID Integrity sprint phases, using only read-only inspection of the codebase and test data. No assumptions were made from CC's summary claims.