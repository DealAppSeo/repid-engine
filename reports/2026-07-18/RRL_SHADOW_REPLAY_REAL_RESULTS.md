# RRL Shadow Replay — WS2.3 on REAL LABELED HAL OUTCOMES

**Generated:** 2026-07-19T02:47:01.855Z  
**Event source:** `C:\Users\Cash4\repos\repid-engine\reports\2026-07-18\hal-outcomes.jsonl` (REAL — 5-strong factCheck quorum × decontaminated corpus, graded vs known labels)  
**Scorer:** `src/rrl/scoring.ts` (RRLScorer, LOCKED WS2.2 core) · **Sink:** `C:\Users\Cash4\repos\repid-engine\reports\2026-07-18\rrl-shadow-ledger-real.jsonl`  
**Labeled rows:** 250 · **Scored rows (TRUE/FALSE gt):** 250 · **Provider-agents:** 5 · **Ledger rows:** 2004  

> **REAL-DERIVED**, not synthetic. Each provider/family in the quorum is a real RRL agent; every event is a real graded verdict. NO live RepID read/written; NO on-chain/ZKP. Shadow ledger only.
> **Single-shot corpus caveat:** the labeled corpus is one verdict per claim, so repair (M1), concealment-surfacing, and error-farming (M6) have NO signal here — those mechanisms are UNEXERCISED by real data. M8 escrow + M4 lazy/coverage + calibration + M9 credential + M5/M2 cross-agent do exercise.

## Exit-gate results (RE-INTERPRETED for a single honest cohort)

| Gate | Metric (real-data reading) | Value | Threshold | Verdict |
|---|---|---:|---|---|
| 1 Calibration | ECE over all real committed provider answers (RAW) | 0.132 | < 0.05 | ❌ |
| 2 Rewards-reliability* | Pearson(acc, cumΔ) & most-accurate = top-ranked | 0.818 / false | >0 & true | ❌ |
| 3 No divergence | providers nuked below baseline despite acc≥0.6 | 1 | 0 | ❌ |
| 4 Detector FP (raw) | detector-fire rate, ALL providers | 0.202 | < 0.05 | ❌ |
| 4b Detector FP (live) | detector-fire rate, excl. infra-dead providers | 0.002 | < 0.05 | ✅ |

*Gate 2 is RE-INTERPRETED: the synthetic gate ("honest cohort tops gaming cohorts") is **NOT EVALUABLE** on real data — there are no gaming archetypes among real providers. The honest real-data analog is "does RRL reward the more reliable providers?" (Pearson over LIVING providers, most-accurate = top-ranked). Treat a fail here as a signal about provider calibration/agreement, not proof of gaming.

⚠️ **Infra-dead providers (0 committed answers — a stale key or dead endpoint, NOT gaming):** groq(llama). Each trips the M4 coverage-floor detector every round, which is why Gate-4 RAW > Gate-4 LIVE. This is a real FP *source* to be aware of, but its cause is infrastructure, not the RRL rule mis-firing on an honest working agent. Gate 4b excludes them.

### VERDICT (real labeled outcomes): ⚠️ one or more gates did NOT pass on real data — see the honest finding below

### Honest reliability diagram (Gate 1 detail — all real committed provider answers)

| Conf bin | n | Mean stated conf | Realized accuracy | |gap| |
|---|---:|---:|---:|---:|
| 0.6-0.7 | 97 | 0.602 | 0.918 | 0.316 |
| 0.7-0.8 | 32 | 0.720 | 0.813 | 0.092 |
| 0.8-0.9 | 66 | 0.811 | 0.697 | 0.114 |
| 0.9-1.0 | 718 | 0.958 | 0.848 | 0.110 |

## Provider-agent reputation ordering (shadow cumΔ on REAL labels)

| Rank | Provider | Family | cumΔ | Would-be RepID | Realized acc | Coverage | Committed | Events | Detector fires | Status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | grok | grok | 339.7 | 1340 | 0.848 | 0.924 | 231 | 250 | 0 | live |
| 2 | deepseek | deepseek | 258.6 | 1259 | 0.890 | 0.980 | 245 | 250 | 0 | live |
| 3 | openrouter-qwen | qwen | 149.4 | 1149 | 0.838 | 0.764 | 191 | 250 | 2 | live |
| 4 | openrouter-gemini | gemini | -200.0 | 800 | 0.797 | 0.984 | 246 | 250 | 0 | live |
| 5 | groq | llama | -625.0 | 375 | 0.000 | 0.000 | 0 | 250 | 250 | 🔴 infra-dead |

## Reproducibility
```
npx tsx scripts/hal/label-run.ts            # produce the real labeled outcomes
npx tsx scripts/rrl/shadow-replay.ts --mode real --labels reports\2026-07-18\hal-outcomes.jsonl              # calibration OFF (raw ECE)
npx tsx scripts/rrl/shadow-replay.ts --mode real --calibrate --labels reports\2026-07-18\hal-outcomes.jsonl  # calibration ON (out-of-sample recalibrated ECE)
```