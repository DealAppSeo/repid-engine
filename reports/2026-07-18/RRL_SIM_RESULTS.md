# RRL Honesty-Dominance Simulation — Results

**Generated:** 2026-07-18T23:08:21.473Z  
**Sim:** `scripts/rrl/honesty-sim.ts` · **Seed:** 1337 · **Rounds:** 4000 · **Agents/strategy:** 8 (colluders in cliques of 4)  
**Design:** reports/2026-07-18/RRL_DESIGN_v0.md  

> **Scoring rule (proper):** `delta = R − K·(p−outcome)²`, R=4, K=20 (break-even Brier 0.200). Repair = recover lost portion + capped bonus 3, learning-adjusted decay (recency window 40 rounds, λ=0.9). Concealment multiplier 3×. All strategies share competence 0.8 so ranking reflects **strategy, not skill**. Metric = cumulative earned Δ (unclamped); RepID shown clamped to the live [10,10000].

## 1. Final reputation ranking — all 9 mechanisms ON

| Rank | Strategy | Mean cumΔ | Mean RepID | Accuracy | Coverage | Mean conf | Calib err |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | honest-calibrated **←honest** | 7129.52 | 8130 | 0.731 | 1.000 | 0.725 | 0.006 |
| 2 | herd-follower | 2372.98 | 3373 | 0.799 | 1.000 | 0.850 | 0.051 |
| 3 | colluder | -8231.59 | 10 | 0.766 | 1.000 | 0.724 | 0.043 |
| 4 | overconfident | -8533.97 | 10 | 0.728 | 1.000 | 0.970 | 0.242 |
| 5 | sandbagger | -12315.55 | 10 | 0.734 | 0.150 | 0.728 | 0.007 |
| 6 | concealer | -12725.47 | 10 | 0.724 | 1.000 | 0.725 | 0.001 |
| 7 | error-farmer | -30764.72 | 10 | 0.000 | 1.000 | 0.350 | 0.350 |


**PASS criterion:** honest-calibrated ranks #1 AND no dishonest strategy out-earns it.  
**Honest rank:** #1 of 7. **No dishonest beats honest:** true.

### VERDICT: ✅ PASS — honesty is the dominant strategy

## 2. Ablation

### 2a. Base proper-scoring-rule ONLY (all 9 mechanisms OFF)

Isolates what the Brier proper rule + repair + concealment asymmetry deliver with zero anti-gaming hardening.

| Rank | Strategy | Mean cumΔ | Mean RepID | Accuracy | Coverage | Mean conf | Calib err |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | error-farmer | 18197.00 | 10000 | 0.000 | 1.000 | 0.350 | 0.350 |
| 2 | honest-calibrated **←honest** | 6468.32 | 7468 | 0.726 | 1.000 | 0.726 | 0.000 |
| 3 | herd-follower | 2986.00 | 3986 | 0.800 | 1.000 | 0.850 | 0.050 |
| 4 | colluder | 1706.12 | 2706 | 0.771 | 1.000 | 0.725 | 0.046 |
| 5 | sandbagger | 80.48 | 1080 | 0.730 | 0.149 | 0.728 | 0.003 |
| 6 | overconfident | -4874.20 | 10 | 0.723 | 1.000 | 0.970 | 0.247 |
| 7 | concealer | -6837.22 | 10 | 0.725 | 1.000 | 0.725 | 0.000 |


Base-rule honest rank: #2. The proper rule alone is NOT sufficient — at least one exploit beats honesty without the mechanisms.

### 2b. Single-mechanism ablation (one OFF, other eight ON)

"Winner" = top earner. "Honest lead over #2" shows how much each mechanism widens honesty's margin (its marginal contribution given the others).

| Mechanism OFF | Honest rank | Winner | Honest lead over #2 | Δ vs baseline lead | Exploit wins? |
|---|---:|---|---:|---:|---|
| (baseline, all ON) | #1 | honest-calibrated | 4756.53 | — | no |
| M1 learning-adjusted repair | #1 | honest-calibrated | 5320.11 | 563.57 | no |
| M2 peer-prediction / BTS | #1 | honest-calibrated | 4790.70 | 34.16 | no |
| M3 residual-correlation detector | #1 | honest-calibrated | 4756.53 | 0.00 | no |
| M4 lazy/sandbag coverage penalty | #1 | honest-calibrated | 4756.53 | 0.00 | no |
| M5 reward independent-correct | #1 | honest-calibrated | 4247.77 | -508.76 | no |
| M6 rotating red-team | #1 | honest-calibrated | 4322.75 | -433.78 | no |
| M7 ecosystem-contribution multiplier | #1 | honest-calibrated | 4613.46 | -143.08 | no |
| M8 retrospective/escrow scoring | #1 | honest-calibrated | 4755.16 | -1.38 | no |
| M9 calibration-over-time credential | #1 | honest-calibrated | 3565.57 | -1190.96 | no |


**Single-mechanism load-bearing (removing alone lets an exploit win):** none — every exploit is defended by more than one mechanism, so no single removal flips the ranking (defense-in-depth). Marginal contribution is read from the "Δ vs baseline lead" column, and the family ablation below isolates each exploit.

### 2c. Family ablation — turn OFF every mechanism that defends a given exploit

This is the real load-bearing test: if the whole defense family for an exploit is removed, does that exploit win? "Winner cumΔ" vs "Honest cumΔ" shows the flip.

| Family OFF | Targeted exploit | Winner | Winner cumΔ | Honest cumΔ | Exploit cumΔ | Exploit now beats honest? |
|---|---|---|---:|---:|---:|---|
| Anti-error-farming (M1+M6 off) | error-farmer | error-farmer | 12647.69 | 7743.95 | 12647.69 | 🔴 YES — load-bearing |
| Anti-collusion (M2+M3+M7 off) | colluder | honest-calibrated | 6200.37 | 6200.37 | 1048.83 | no — honesty holds |
| Anti-sandbag (M4 off) | sandbagger | honest-calibrated | 7129.52 | 7129.52 | 265.38 | no — honesty holds |
| Anti-herd (M5 off) | herd-follower | honest-calibrated | 6620.76 | 6620.76 | 2372.98 | no — honesty holds |
| Anti-concealment (M6+M8 off) | concealer | honest-calibrated | 7163.08 | 7163.08 | -5529.16 | no — honesty holds |
| Anti-overconfidence (M8+M9 off) | overconfident | honest-calibrated | 7313.89 | 7313.89 | -2990.01 | no — honesty holds |


**Load-bearing families (removing the whole defense lets the exploit match/beat honesty):** Anti-error-farming (M1+M6 off) → error-farmer wins.

**Families that turned out NOT load-bearing (honesty holds even with the whole family off):** Anti-collusion (M2+M3+M7 off); Anti-sandbag (M4 off); Anti-herd (M5 off); Anti-concealment (M6+M8 off); Anti-overconfidence (M8+M9 off) — for these, honesty is protected by the base proper scoring rule itself, so the named mechanisms are redundant given the rule (report-honest finding, not a tuned outcome)..

### 2d. Deterrence value — each exploit's reputation, base-rule-only vs all-mechanisms

A mechanism family can be "not load-bearing for honesty's #1 RANK" yet still essential for DETERRENCE — driving an exploit from mildly-profitable to actively reputation-losing. That matters under population shift (if agents drift toward an exploit). This isolates that value.

| Exploit | cumΔ base-rule-only | cumΔ all-ON | Mechanisms' effect |
|---|---:|---:|---|
| overconfident | -4874.20 | -8533.97 | ↓ 3659.77 (deterred) |
| sandbagger | 80.48 | -12315.55 | ↓ 12396.03 (deterred) |
| error-farmer | 18197.00 | -30764.72 | ↓ 48961.72 (deterred) |
| colluder | 1706.12 | -8231.59 | ↓ 9937.70 (deterred) |
| herd-follower | 2986.00 | 2372.98 | ↓ 613.02 (deterred) |
| concealer | -6837.22 | -12725.47 | ↓ 5888.25 (deterred) |


**Surviving exploit with everything ON:** none — no exploit matches or beats honesty with all mechanisms on.

## 3. Antifragility — honest advantage as adversarial pressure rises

Difficulty and trap-probability (misleading public/majority signal) rise linearly across the run. Antifragile ⇒ honest per-round advantage over the best deceptive strategy HOLDS or IMPROVES as pressure climbs.

| Round window | Mean trap prob | Honest Δ/round | Best dishonest | Its Δ/round | Honest advantage |
|---|---:|---:|---|---:|---:|
| 0-999 | 0.269 | 1.651 | herd-follower | -0.520 | 2.171 |
| 1000-1999 | 0.406 | 1.608 | sandbagger | -2.094 | 3.703 |
| 2000-2999 | 0.544 | 1.464 | sandbagger | -2.120 | 3.584 |
| 3000-3999 | 0.681 | 1.425 | sandbagger | -2.125 | 3.550 |


**Antifragility check:** honest advantage first window 2.171 → last window 3.550 → ✅ HOLDS/IMPROVES.

## 4. Sensitivity — concealment ratio and repair-bonus size

One knob at a time, all mechanisms ON. Shows honest rank plus the directly-affected exploit's cumΔ so the knob is visibly load-bearing.

| Variant | Honest rank | Honest cumΔ | Affected exploit | Its cumΔ | Honest still #1 |
|---|---:|---:|---|---:|---|
| concealMult 2× | #1 | 7129.52 | concealer | -7947.70 | ✅ |
| concealMult 3× (default) | #1 | 7129.52 | concealer | -12725.47 | ✅ |
| concealMult 5× | #1 | 7129.52 | concealer | -22281.01 | ✅ |
| repairBonus 1.5 (half) | #1 | 6434.81 | error-farmer | -20052.01 | ✅ |
| repairBonus 3.0 (default) | #1 | 7129.52 | error-farmer | -30764.72 | ✅ |
| repairBonus 6.0 (2× larger) | #1 | 8518.94 | error-farmer | -52190.13 | ✅ |


Note: a **larger repair bonus** is the knob that could open error-farming — if it ever lets error-farmer approach honesty, M1's learning-decay + M6's red-team are what must keep pace. A **larger concealment multiplier** monotonically sinks the concealer.

## 5. Robustness — verdict across independent seeds

The PASS verdict must not be a single-seed artifact. Re-runs the full main scenario (all mechanisms ON) on 6 independent seeds.

| Seed | Honest rank | No dishonest beats honest | Honest cumΔ | #2 strategy | #2 cumΔ |
|---:|---:|---|---:|---|---:|
| 1337 | #1 | true | 7129.52 | herd-follower | 2372.98 |
| 1 | #1 | true | 7030.25 | herd-follower | 2827.26 |
| 42 | #1 | true | 7087.89 | herd-follower | 3157.22 |
| 2718 | #1 | true | 6991.17 | herd-follower | 2586.22 |
| 99999 | #1 | true | 7098.62 | herd-follower | 2383.01 |
| 7 | #1 | true | 7031.23 | herd-follower | 2661.60 |


**Robustness:** ✅ honest ranks #1 with no dishonest strategy out-earning it on EVERY seed tested.

## Reproducibility

```
npx tsx scripts/rrl/honesty-sim.ts --seed 1337 --rounds 4000
```

Deterministic Mulberry32 RNG; identical seed → identical numbers. No LLM, no infra, no DB.

_Discipline note: parameters were fixed a-priori from the design doc's approved values and NOT tuned to make honesty win. Any surviving exploit / non-load-bearing mechanism above is reported, not hidden (RULE-4)._