# RRL Shadow Replay — WS2.3 Stage-0 Exit-Gate Metrics

**Generated:** 2026-07-19T00:37:59.079Z  
**Harness:** `scripts/rrl/shadow-replay.ts` · **Scorer:** `src/rrl/scoring.ts` (RRLScorer) · **Sink:** `C:\Users\Cash4\repos\repid-engine\reports\2026-07-18\rrl-shadow-ledger.jsonl`  
**Seed:** 1337 · **Rounds:** 800 · **Agents/archetype:** 3 · **Total agents:** 18 · **Ledger rows:** 24747  
**Run id:** `shadow-replay-1337-800-2026-07-19`  

> ⚠️ **EVENT SOURCE = SYNTHETIC (labeled).** Real HAL/peer-verify signal was probed read-only and is NOT cleanly available (hal_production_events: 5 rows, 0 with a ground-truth outcome). This replay mirrors the sim's agent strategies to exercise the exit-gate machinery end-to-end. NO live RepID was read or written; NO on-chain/ZKP. Shadow ledger only.

## Exit-gate results

| Gate | Metric | Value | Threshold | Verdict |
|---|---|---:|---|---|
| 1 Calibration | Expected Calibration Error (honest cohort reliability diagram) | 0.012 | < 0.05 | ✅ |
| 2 Honesty-order | honest cohort rank / tops all gaming | #1 / true | #1 & true | ✅ |
| 3 No divergence | unexplained catastrophic agents | 0 | 0 | ✅ |
| 4 Detector FP | detector-fire rate on honest agents | 0.001 | < 0.05 | ✅ |

_Supporting context (not a gate): Pearson(accuracy, unclamped cumΔ) across all archetypes = 0.798. Deliberately NOT gated on — RRL rewards calibration + honesty, so an accurate-but-herding agent correctly earns less, which suppresses a raw accuracy↔reward correlation. The reliability diagram above is the correct calibration statistic._

### Honest-cohort reliability diagram (Gate 1 detail)

| Conf bin | n | Mean stated conf | Realized accuracy | |gap| |
|---|---:|---:|---:|---:|
| 0.5-0.6 | 42 | 0.579 | 0.667 | 0.087 |
| 0.6-0.7 | 800 | 0.665 | 0.651 | 0.013 |
| 0.7-0.8 | 1299 | 0.746 | 0.746 | 0.000 |
| 0.8-0.9 | 252 | 0.830 | 0.782 | 0.048 |
| 0.9-1.0 | 7 | 0.920 | 1.000 | 0.080 |

### VERDICT (synthetic exercise): ✅ all four exit-gate metrics computable and passing on the synthetic stream

_Note: passing on SYNTHETIC data proves the exit-gate machinery is wired and discriminating; it is NOT the WS2.3 promotion evidence. Promotion requires the same gates to hold on REAL traffic (Stage-0.5) plus human co-sign (A6)._

## Cohort reputation ordering (shadow cumΔ)

| Rank | Archetype | Mean cumΔ | Mean would-be RepID | Mean accuracy | Mean coverage |
|---:|---|---:|---:|---:|---:|
| 1 | honest-calibrated **←honest** | 1137.4 | 2137 | 0.717 | 1.000 |
| 2 | herd-follower | 573.7 | 1574 | 0.813 | 1.000 |
| 3 | overconfident | -1928.9 | 10 | 0.730 | 1.000 |
| 4 | sandbagger | -2495.1 | 10 | 0.758 | 0.145 |
| 5 | concealer | -2951.0 | 10 | 0.714 | 1.000 |
| 6 | error-farmer | -6210.0 | 10 | 0.000 | 1.000 |

## Divergence detail (Gate 3)

Baseline live RepID (synthetic) = 1000. "Explained" = shadow direction matches ground-truthed accuracy, or agent is a known gaming archetype.

| Agent | Archetype | Would-be RepID | Accuracy | Explained |
|---|---|---:|---:|---|
| honest-calibrated#0 | honest-calibrated | 2122 | 0.720 | yes |
| honest-calibrated#1 | honest-calibrated | 2206 | 0.729 | yes |
| honest-calibrated#2 | honest-calibrated | 2083 | 0.704 | yes |
| overconfident#0 | overconfident | 10 | 0.719 | yes |
| overconfident#1 | overconfident | 10 | 0.736 | yes |
| overconfident#2 | overconfident | 10 | 0.736 | yes |
| sandbagger#0 | sandbagger | 10 | 0.774 | yes |
| sandbagger#1 | sandbagger | 10 | 0.716 | yes |
| sandbagger#2 | sandbagger | 10 | 0.784 | yes |
| error-farmer#0 | error-farmer | 10 | 0.000 | yes |
| error-farmer#1 | error-farmer | 10 | 0.000 | yes |
| error-farmer#2 | error-farmer | 10 | 0.000 | yes |
| concealer#0 | concealer | 10 | 0.713 | yes |
| concealer#1 | concealer | 10 | 0.715 | yes |
| concealer#2 | concealer | 10 | 0.715 | yes |
| herd-follower#0 | herd-follower | 1574 | 0.813 | yes |
| herd-follower#1 | herd-follower | 1574 | 0.813 | yes |
| herd-follower#2 | herd-follower | 1574 | 0.813 | yes |

## Reproducibility
```
npx tsx scripts/rrl/shadow-replay.ts --seed 1337 --rounds 800 --agents 3
```
Deterministic (Mulberry32, same seed → same ledger). Scorer = the same locked core the sim uses.