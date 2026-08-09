# HAL veto effectiveness — the reproducible offline floor, and the gap to the real number

**Lane:** HAL effectiveness — "is the veto actually good?" made a measurement, not a claim.
**Date:** 2026-08-09 · **Branch-only, keyless, no live fleet.**

## What was built

A committed, runnable, **keyless** evaluator that measures the HAL **VETO** decision against
the frozen, hashed labeled corpus, in-process:

- `scripts/hal-eval/run-frozen-corpus-offline.ts` — drives `src/hal/lib/evaluate` directly
  with `providers: []`. Enforces the corpus **hash gate** (refuses to measure a corpus whose
  content no longer hashes to `MANIFEST.json`), computes TP/FP/TN/FN, precision, recall, F1,
  accuracy, and a Mann-Whitney AUC, and writes a report that carries its ruler.
- `tests/hal-frozen-corpus-offline-eval.test.ts` — 11 passing tests: confusion-matrix
  arithmetic on synthetic known labels, the hash gate accepting the real corpus and refusing a
  wrong hash, and a **real** keyless end-to-end run over the canary holdout that asserts 100%
  coverage, determinism, and that the ruler never claims the quorum ran.

This closes a reproducibility gap: `reports/hal-eval/rigorous-v1-holdout-...LOCAL.json`
(F1 0.9167, "in-process halService") was committed, and `scripts/hal-eval/fit-calibration.ts`
depends on it, but **the script that produced it was never committed** — that number is not
reproducible from the tree. The offline evaluator here is.

## The measured number, with its ruler

Rule 24: a measurement without its ruler is not a result.

| corpus @ hash | split | rows | precision | recall | **F1** | accuracy | AUC |
|---|---|---|---|---|---|---|---|
| `rigorous-v1@596f10de18d0` | holdout | 99 | 0.521 | 0.792 | **0.628** | 0.545 | **0.558** |
| `canary-v1@dbaf5dbd4e55` | holdout | 15 | 0.545 | 1.000 | **0.706** | — | **0.769** |

**Ruler (both):** `offline-extractor · strictness 1 · providers=NONE · quorum=NOT-EXERCISED ·
transport=in-process src/hal/lib/evaluate`. Positive class = hallucination (label `FALSE`);
predicted-positive = `vetoed`.

Reproduce:
```
npx ts-node scripts/hal-eval/run-frozen-corpus-offline.ts --corpus rigorous-v1 --split holdout
```
Artifacts: `reports/hal-eval/{rigorous-v1-holdout-596f10de18d0,canary-v1-holdout-dbaf5dbd4e55}.OFFLINE.json`.

## What this number does and does NOT say — read before quoting

`providers: []` means `evaluate.ts` **skips the Layer-1 disjoint-family cross-LLM quorum**
(it gates on `providers.length > 0`). So this measures the **offline extractor path only** —
the same pure signal path the live score-event pipeline runs at strictness 1 — **not** the
fact-check quorum.

The honest read is the **AUC, not the F1**. AUC on rigorous-v1 is **0.558** — barely above the
0.5 no-separation line. The F1 of 0.628 is largely the base rate: the default veto threshold
(0.25) vetoes most rows, so recall is high (0.79) and precision collapses to ≈ the FALSE base
rate (0.52). **The extractor alone cannot tell a true factual claim from a false one** — it has
no way to look up whether "Australia's population > Canada's". This confirms the PR#77
diagnosis (Class-B: the live extractor path lacks discriminative power) on the frozen corpus.

A useful side finding: **strictness 1 and strictness 2 are byte-identical here** (test-asserted),
because without providers the strictness≥2 machinery is inert. Strictness only matters once the
quorum can run.

## The gap — named exactly

The question "is HAL's veto good?" is answered by the **quorum**, and the quorum is **not
exercisable keyless** in this fenced worktree. To get that number:

- `scripts/hal-eval/run-frozen-corpus.mjs` measures the **live keyed endpoint** (the real
  disjoint-family quorum) against the same frozen corpus, with a coverage gate that refuses to
  print an F1 when transport failures starve the run. It needs the fleet up and provider keys —
  a **Sean-gated / deployed-env** run, not a branch operation.
- The committed `...LOCAL.json` (F1 0.9167, keyed in-process halService) is the best existing
  quorum estimate but is **currently unreproducible from committed code**. Committing the keyed
  in-process runner (the untracked `run-frozen-corpus-local.ts`) is the follow-up that would make
  the 0.9167 reproducible — out of scope for a keyless lane.

**BLOCKED_FOR_SEAN:** the headline quorum F1 (rigorous-v1 holdout, ≥3 families, keyed) needs a
live/keyed run of `run-frozen-corpus.mjs` or a committed keyed in-process runner. This lane
delivered the reproducible **floor** and the harness; the quorum number is a keyed run away.

## Evidence

- `npx jest --config jest.config.js tests/hal-frozen-corpus-offline-eval.test.ts` → **11 passed**.
- `npx tsc --noEmit` → clean (exit 0).
- Two OFFLINE report JSONs written under `reports/hal-eval/`, each carrying corpus hash +
  config in its `ruler` field.
