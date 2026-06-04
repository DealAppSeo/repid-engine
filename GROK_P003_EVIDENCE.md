# P-003 Evidence — Claim the Cross-LLM Quorum, Drop "Pythagorean" (2026-06-03)

**For Grok, via Sean.** Two independent ablations (R1 scalar test, R2 cyclic-drift test) on a 165-case
labeled corpus (HAL_test_cases + TruthfulQA), free-tier cross-LLM quorum, cached. Both say the same
thing: the discriminative power is the **cross-LLM agreement quorum**, not the Pythagorean comma.

## The numbers (positive class = hallucination)

| Signal | AUC | Reading |
|---|---|---|
| **Flat 3+ LLM majority vote (quorum)** | **0.92** (N=62, 4-validator) / 0.81 (N=17 free-tier) | the real discriminator |
| Cross-LLM fact-check (HAL, R1) | 0.775 (N=109 persisted) | strong |
| Comma cycle-closure **drift** (R2) | **0.12** literal / **0.21** shifted | **below chance** |
| Live blind extractor | 0.38–0.45 | below chance, anti-correlated |

## Why the comma is not load-bearing (two operationalizations, both fail)

1. **As a scalar multiplier (R1):** `hal_score × (531441/524288)` is a constant monotone transform →
   AUC and rank-separation are *invariant* to it. It cannot change discrimination; it only shifts the
   veto rate. Proven analytically and empirically (ΔAUC = 0).
2. **As a cyclic-consensus drift veto (R2):** veto when the cycle-closure drift of pairwise agreement
   ratios exceeds the comma excess (0.013643). Decisive test = 5-fold **cross-validated** held-out F1,
   comma threshold (B) vs the best grid-tuned threshold (C). Result: **B = C = 0.6345, ΔB−C = 0.0000**
   for both the literal and a non-saturating belief variant. The drift statistic itself is
   non-discriminative (AUC 0.12/0.21), so no threshold — comma-derived or tuned — recovers signal.

## Recommendation

- **Drop the "Pythagorean comma" specificity from P-003.** The value 531441/524288 is not what
  separates truth from hallucination in any tested operationalization.
- **Claim what works:** a cross-LLM **agreement/quorum** veto — independent validators, majority/
  confidence-weighted verdict (AUC ≈ 0.92). That is the novel, defensible, measured mechanism.
- If a consensus-drift gate is kept, claim it generically (an empirically-tuned cyclic-consensus
  threshold) and justify it for what it actually does — flagging *contested / low-consensus* claims —
  not hallucination detection.

Artifacts: `scripts/hal-ablation/data/comma-ablation-results.json` (R2, N=62), `persisted-bc.json`
(R1, N=109), `ablation-results.json` (R1 fresh). Reproducible at $0 from cached verdicts.
