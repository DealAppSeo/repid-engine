# EARNED MODEL LEADERBOARD — provider ratings from verified canary fact-checks

> **These ratings are EARNED from 47 verified fact-checks, each carrying its receipt** — the honest
> alternative to "which LLM is best" listicles. No vibes, no vendor benchmarks: every number below comes
> from a real cross-LLM quorum run whose per-provider, per-claim verdicts were scored against a
> known-answer oracle.

## The participant-rating laws this demonstrates
1. **A rating exists only from a verified engagement.** A provider is rated only if it actually voted on
   real claims. A provider that 429'd/errored the entire run gets a **coverage note, never a fabricated score**.
2. **Anchored to ground truth.** Every axis is scored against the corpus's known TRUE/FALSE labels — not
   against other models' opinions.
3. **Every rating carries its receipt.** Each row records the canary run, how many claims it was verified on,
   and the corpus version + hash. Fully auditable.

## Receipt (applies to every row)
| field | value |
|---|---|
| canary run | `reports/2026-07-07/canary-f1-raw-2026-07-08T02-17-06-804Z.json` |
| run generated at | 2026-07-08T02:17:06.804Z |
| run sha256 | `b08740e560529b40cacb3a23a3fdc1dd9aa990b4c2baa29a414b02b6df1cb826` |
| corpus (oracle N) | `eval/canary/canary-corpus-v1.1.jsonl` |
| corpus scope | clean-oracle (v1.1) |
| corpus sha256 | `b244c3c63d5d6f15cb4e48487b74ec9dcc861a5b4c0298e3d8c48be47edd7e1e` |
| `CLEAN_CORPUS` used | `eval/canary/canary-corpus-v1.1.jsonl` |
| raw run size → scored | 50 → 47 (**3 dropped**) |
| **oracle N (claims asked)** | **47** |

**Rows dropped by the clean-oracle filter (3), named for reproducibility:**
  - idx 1 [TRUE/easy]: "The boiling point of water at standard sea-level atmospheric pressure is 100°C exactly."
  - idx 7 [FALSE/medium]: "Humans share approximately 50% of their DNA with bananas."
  - idx 8 [TRUE/hard]: "Humans share approximately 60% of their DNA with bananas."

> **Small-N caveat.** N=47 known-answer claims — directional, not a benchmark leaderboard. Treat as an earned snapshot from one verified run, not a universal ranking.
> Per-provider **committed** votes vary (the oracle N=47, but a provider only gets scored on the
> claims it actually voted on) — every row below shows both.

## Leaderboard — MAIN (coverage ≥ 80% committed; axes kept SEPARATE)
Only providers that committed a firm TRUE/FALSE vote on **≥ 80% of the oracle** appear here.
Coverage is a **gate, not a tie-breaker** — a provider cannot rank by abstaining/erroring on the hard rows.
Providers below the floor are in the **Provisional** section and are *not* comparable to full-coverage rows.
Accuracy is always shown with its committed denominator and the abstain/error tail. Calibration cells show
their own N; ⚠ = fewer than 5 committed votes (a "100%" off 1 sample is not a real 100%).

| provider | model | family | accuracy (committed · tail) | calib: easy / hard acc (N) | conf-when-wrong ↓ | coverage (committed) | errors | latency med/p95 ms | committed/total |
|---|---|---|---|---|---|---|---|---|---|
| deepseek | `deepseek-chat` | deepseek | **100%** (47/47 committed · 0 abstain · 0 err of 47) | 100% (n=31) / 100% (n=4) ⚠ | — | 100% (47/47) | 0 | 296 / 350 | 47/47 |
| mistral | `mistral-small-latest` | mistral | **93.6%** (44/47 committed · 0 abstain · 0 err of 47) | 100% (n=31) / 75% (n=4) ⚠ | 98.3 | 100% (47/47) | 0 | 542 / 668 | 47/47 |
| groq | `llama-3.1-8b-instant` | llama | **91.5%** (43/47 committed · 0 abstain · 0 err of 47) | 96.8% (n=31) / 100% (n=4) ⚠ | 92.5 | 100% (47/47) | 0 | 274 / 356 | 47/47 |

## Provisional — insufficient coverage to rank (coverage < 80% committed)
> These providers voted on too small a self-selected subset of the oracle to be ranked against the fully-covered
> providers above. A high accuracy here is on a **survivor subset** (the claims it did not error/abstain on),
> not the full oracle — do **not** read it as "beats" a MAIN-table provider.

| provider | model | family | accuracy (committed · tail) | calib: easy / hard acc (N) | conf-when-wrong ↓ | coverage (committed) | errors | latency med/p95 ms | committed/total |
|---|---|---|---|---|---|---|---|---|---|
| cerebras | `zai-glm-4.7` | glm | **100%** (10/10 committed · 10 abstain · 27 err of 47) | 100% (n=6) / 100% (n=1) ⚠ | — | 21.3% (10/47) | 27 | 3832 / 4302 | 10/47 |

## Unrated providers (LAW 1 — no verified engagement, so no score)
| provider | model | status | reason |
|---|---|---|---|
| gemini | `gemini-2.0-flash` | UNRATED — no verified engagement | 47/47 calls errored (429/quota/timeout); 0 real verdicts. Per LAW 1, no score is fabricated. |
| openrouter | `qwen/qwen3-next-80b-a3b-instruct:free` | UNRATED — no verified engagement | 47/47 calls errored (429/quota/timeout); 0 real verdicts. Per LAW 1, no score is fabricated. |

## Axis definitions
- **accuracy_pct** — of the claims where the provider committed a firm TRUE/FALSE verdict, the fraction that
  matched the known label. Always shown as `% (correct/committed · abstain · err of seen)` so the
  self-selected denominator is visible. Abstentions and errors are excluded from the ratio (they can't be
  right or wrong) but are always reported alongside it.
- **coverage GATE** — `committed%` = firm votes / oracle claims seen. A provider must clear
  **80%** to appear in the MAIN table; below it it's Provisional. `errors` = 429/quota/timeout.
- **calibration** — two facets: (a) *easy vs hard accuracy*, each shown with its N and a ⚠ low-N flag
  (< 5 committed votes), so a 1/1 "100%" is never read like a full-N 100%; and
  (b) *mean confidence when wrong* — a well-calibrated model is **less** confident on the answers it gets wrong.
- **latency** — median / p95 ms on real (non-error) replies. Optional axis; captured because the run logged it.
- **committed/total** — firm TRUE/FALSE votes the provider cast / oracle claims it was asked (the header's N).

## Quorum manifest (models under test this run)
| provider | model | family |
|---|---|---|
| groq | `llama-3.1-8b-instant` | llama |
| cerebras | `zai-glm-4.7` | glm |
| deepseek | `deepseek-chat` | deepseek |
| gemini | `gemini-2.0-flash` | gemini |
| mistral | `mistral-small-latest` | mistral |
| openrouter | `qwen/qwen3-next-80b-a3b-instruct:free` | qwen |

## How to reproduce
```bash
# 1. (re)generate the verified verdicts — real cross-LLM quorum, live keys:
npx ts-node scripts/eval/canary-f1.ts
# 2. re-score into this leaderboard (pure, deterministic, no LLM calls).
#    Pin the exact inputs so the numbers below are fully reconstructable:
CANARY_RAW='reports/2026-07-07/canary-f1-raw-2026-07-08T02-17-06-804Z.json' \
CLEAN_CORPUS='eval/canary/canary-corpus-v1.1.jsonl' \
  npx ts-node scripts/eval/model-leaderboard.ts
# The clean-oracle filter scores 47 of the raw run's 50 rows
# (drops 3: idx 1, 7, 8 — see the Receipt section for the named claims).
```

_Generated by `scripts/eval/model-leaderboard.ts` — a deterministic re-scoring of already-verified verdicts._
