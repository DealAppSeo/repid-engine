# HAL quorum F1 — made reproducible (headline "is the veto actually good" number)

**Date:** 2026-08-09
**Lane:** THE keyed HAL quorum F1 — measure whether the veto is actually good, reproducibly.
**Status:** REAL measurement, reproducible from committed code.

## The gap this closes

A number — `F1 0.9167` — sat in `reports/hal-eval/rigorous-v1-holdout-596f10de18d0.LOCAL.json`
on `main`, but the script that produced it (`scripts/hal-eval/run-frozen-corpus-local.ts`) was
**never committed** (untracked, `??` in git status). A committed result whose generator is not
committed is not reproducible — you cannot re-derive it, and CLAUDE_RULES 24 ("a measurement
without its ruler is not a result") makes it inadmissible as a claim. This lane commits the
generator, re-runs it against the frozen corpus holdout with real provider keys, and reports the
number **with its full ruler and the exact provider set that answered**.

## What was committed

- `scripts/hal-eval/run-frozen-corpus-local.ts` — the in-process quorum evaluator. Reviewed: it
  hardcodes **no key**; provider keys are loaded from `process.env` / `.env.master` by `dotenv`
  inside the process and never printed, exported, or placed on a command line. Two safety gates:
  a **hash gate** (refuses to measure if the corpus SHA-256 ≠ MANIFEST.json) and a **coverage gate**
  (refuses to print an F1 below 80% scored, so a provider outage can never masquerade as a quality
  result). Extended in this lane to also compute **ROC AUC** and to record **which families
  actually voted** per row.
- `scripts/hal-eval/metrics.ts` — the pure scoring math (confusion matrix, precision/recall/F1,
  tie-aware ROC AUC) extracted so it is unit-testable without any provider call. The runner imports it.
- `tests/hal-quorum-eval-smoke.test.ts` — 10 deterministic tests that pin the *machinery*
  (label/verdict mapping, confusion arithmetic, F1 formula, AUC on known separations incl. the
  tie→0.5 and single-class→null edge cases). The measured F1/AUC itself is **data, not asserted** —
  it depends on live LLMs and legitimately moves run to run.

## The measurement — with its ruler

| field | value |
|---|---|
| **Ruler (corpus @ hash)** | `rigorous-v1@596f10de18d0` (SHA-256 `596f10de…207b50`, verified by the hash gate) |
| **Split** | holdout, **N = 99** rows (the smaller split, to bound token spend) |
| **Labels** | 48 FALSE (hallucination) / 51 TRUE, positive class = hallucination |
| **Strictness** | 2 (the real cross-LLM fact-check quorum, **not** the extractor path) |
| **Transport** | in-process `halService.evaluate()` — no HTTP, no public rate cap |
| **Coverage** | **100%** (99/99 scored, 0 errors) |
| **Quorum path** | **fact-check on 99/99 rows, 0 extractor fallback** |
| **Families per row** | **≥3 on every row** — histogram: 3 families → 18 rows, 4 → 66, 5 → 15 |
| **Families that answered** | `llama` (groq, 82/99), `glm` (cerebras, 15/99), `gemini` (99/99), `mistral` (99/99), `qwen` (openrouter, 98/99) |

### Result

```
Confusion (positive = hallucination):  TP 43   FP 5   FN 5   TN 46
Precision 0.8958   Recall 0.8958   F1 0.8958   Accuracy 0.8990
AUC 0.9732   (ranks the continuous halScore; F1 is at the deployed veto threshold)
```

**F1 = 0.896, AUC = 0.973** on `rigorous-v1@596f10de18d0` [holdout], strictness 2, in-process
≥3-disjoint-family quorum (llama/glm/gemini/mistral/qwen), 100% coverage.

### Reproducibility / stability

Two independent full runs at concurrency 2 both produced **F1 = 0.8958** exactly (AUC 0.9753 and
0.9732 — the AUC moves slightly with LLM nondeterminism, the threshold-based F1 did not). The prior
pre-commit reported value was 0.9167 (TP44/FP4/TN47/FN4). Across all runs the number sits in a
tight **F1 ≈ 0.90–0.92** band — the small movement is LLM nondeterminism plus which free tiers
(groq/cerebras/mistral) rate-limited on a given run. This is now reproducible: run
`npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --split holdout`.

## Honest contrast: quorum vs extractor

The task's reference point is the **extractor-only AUC 0.558** from PR #393 — barely above the 0.5
coin-flip line. This lane's **real cross-LLM quorum scores AUC 0.973** on the same corpus family.
That is the whole thesis of the veto in one comparison: the style-extractor cannot discriminate
hallucination from truth (AUC ≈ 0.56), and the ≥3-family fact-check quorum can (AUC ≈ 0.97, F1 ≈ 0.90).
The `halService` degrades *loudly* to the extractor only when a quorum cannot assemble — on this run
that never happened (0/99 fallback).

## Caveats (the number is only valid with these stated)

- **Provider set is named, not assumed.** Under concurrency-2 burst, the free tiers throttled:
  groq answered 82/99, cerebras only 15/99. The quorum stayed ≥3 families on every row because
  gemini + mistral + qwen answered ~99/99 each. A different provider mix (e.g. all free tiers
  healthy, or paid-only) is a *different ruler* and could move the number.
- **deepseek did not contribute votes** on this run (not in the family-participation map) despite
  its key being present — reported as-is rather than claimed.
- **AUC is a diagnostic, not the deployed metric.** It ranks the continuous `halScore`; the F1 is
  taken at the live veto threshold. They answer different questions and must not be conflated.
- **Holdout only (99 rows).** The larger `train` split (232 rows) was not run here to bound token
  spend; this is a holdout number and is labeled as such.

## Evidence

- Committed artifact: `reports/hal-eval/rigorous-v1-holdout-596f10de18d0.LOCAL.json` (full confusion,
  per-row verdicts + halScores, provider-set breakdown; no keys, no prod rows).
- Reproduce: `SUPABASE_URL=… SUPABASE_SERVICE_KEY=… npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --split holdout --concurrency 2`
  (keys from `.env.master`, loaded in-process).
- Smoke test: `npx jest --config jest.config.js tests/hal-quorum-eval-smoke.test.ts` → 10/10.
