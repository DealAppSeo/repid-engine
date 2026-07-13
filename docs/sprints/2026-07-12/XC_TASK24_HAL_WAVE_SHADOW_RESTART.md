# XC #24 — HAL Wave-Runner + Autotuner: Investigate + Shadow Restart

**Sprint:** `sprint-2026-07-12-ecosystem` · **Lane:** hal-runner (XC exclusive)  
**Agent:** XC/grok · **Date:** 2026-07-13 · **Brain:** `repid_experiment_log` id=41 item 1, id=39 item 1  
**Status:** COMPLETE — shadow-only design + dry-run script; **no live threshold writes**

---

## 0. Ask

1. Locate wave-runner + autotuner code  
2. Report why each stopped  
3. Propose restart that writes **SHADOW** threshold keys only (never `hal_veto_threshold` / `hal_block_threshold`)  
4. Exclude `CONTAMINATED-*` sources from any tuning  
5. Coordinate read-only with GA on `hal_runner_results`

---

## 1. Where the code lives

| Component | Location | Role |
|---|---|---|
| **Wave / external bench harness** | `C:\Users\Cash4\repos\hyperdag-bench` | Writes `hal_runner_results` via `src/persistence/runner-results-writer.ts` |
| Internal prompts runner | `hyperdag-bench/src/runners/internal-prompts-runner.ts` | `npm run bench:internal` |
| Ablation / multi-threshold | `hyperdag-bench/src/runners/ablation-runner*.ts` | wave7-style sweeps |
| Nightly scaffold | `hyperdag-bench/scripts/nightly-run.ts` | **Scaffold only** — real run explicitly blocked (“requires CC1 HAL extraction”) |
| Engine-side external bench | `repid-engine/scripts/hal-eval/run-external-benchmark.ts` | HaluEval/FEVER → `hal_benchmark_results` (different table) |
| Engine validation | `repid-engine/scripts/run-hal-validation.ts` | `hal_validation_runs` |
| **Autotuner writer (production path)** | Mostly **absent as a closed loop** | Last real veto threshold change looks manual/one-shot (2026-06-15) |
| Spurious “autotuner” noise | `src/routes/agents-external.ts` ~L602 | On hallucination_caught inserts `hal_threshold_updates` with `threshold_key='catch_count'` — **counter telemetry**, not threshold learning |
| HITL threshold decouple | `migrations/2026-06-15-hitl-threshold-decouple.sql` | Separates human-trigger vs veto |

There is **no** currently scheduled CI/cron job that (a) runs wave harness → (b) computes F1 from clean labels → (c) proposes veto threshold → (d) writes `hal_threshold_updates`. The measure-learn half of HAL is dark by design of missing orchestration, not a mysterious silent fail.

---

## 2. Live state [V 2026-07-13]

### 2.1 `hal_runner_results` (1,825 rows) — last writers

| Last `created_at` | `benchmark_source` | Notes |
|---|---|---|
| **2026-06-24** | `cc-sprint-9-integration-test` | 1 row, mock seller path — last “real” write |
| 2026-06-09 | `t12-overnight-2026-06` | Large batch (~324 rows), fact-check-s2 |
| 2026-05-07 | `wave8-real-hal-smoke-*` | 117 rows |
| 2026-05-05 | `wave7-multiprovider-*` | 758 rows |
| 2026-05-05 | `CONTAMINATED-wave5-*` | **245 rows — EXCLUDE from tuning** |

**Dark ~19 days** (since 2026-06-24) for any runner write; ~34 days for substantive multi-provider waves.

### 2.2 `hal_threshold_updates` (1,589 rows)

| Last real config change | Keys | Date |
|---|---|---|
| veto 0.50 → **0.43**, verdict_driven_veto 1→0 | `veto_threshold`, `verdict_driven_veto` | **2026-06-15** |
| Mass `catch_count` 0→1 | counter spam | 2026-05-27 (agents-external path) |

All rows `update_type='production'`. **No shadow keys exist today.**

### 2.3 Live thresholds (untouched by this work)

| Key | Value | Role |
|---|---|---|
| `hal_veto_threshold` | 0.43 | LIVE general HAL veto |
| `hal_block_threshold` | 0.55 | LIVE constitutional block |
| `hal_hitl_threshold` | 0.30 | HITL human-trigger (separate) |
| `hal_veto_threshold_6dof` | 0.43 | auto_tunable flag true but **not being updated** |

---

## 3. Why each stopped

### 3.1 Wave harness

1. **Orchestration is scaffolded, not scheduled** — `nightly-run.ts` refuses real execution without “CC1 HAL extraction”; no Railway/GitHub Action continuously calling `bench:internal` / ablation.
2. **Repo is external to engine deploy** — hyperdag-bench is a sibling package; engine deploys do not run it.
3. **Last integration was one-off sprint work** (cc-sprint-9, t12-overnight) — not a productized loop.
4. **Provider/cost friction** historically (wave-era 429s/404s visible in old runner signals) made unattended waves expensive/flaky; no health gate before batch.

### 3.2 Autotuner

1. **No closed-loop job** maps catch-rate → proposed threshold → `hal_threshold_updates`.
2. **1587/1589 rows are `catch_count` counters** from disclosure path — they look like “autotuner activity” in a row-count but do not move veto thresholds.
3. **Sean-gate correct for live veto** — after 2026-06-15 change, nothing was authorized to write production veto keys; without a **shadow channel**, agents correctly stopped.

---

## 4. Shadow-restart design (safe)

### 4.1 Principles

- **Never** UPDATE `repid_config.hal_veto_threshold` / `hal_block_threshold` from this path.
- Write proposals only to:
  - `repid_config` keys: `hal_veto_threshold_shadow`, `hal_block_threshold_shadow`, `hal_shadow_autotune_last_run`
  - `hal_threshold_updates` with `update_type='shadow'` and `threshold_key` in (`veto_threshold_shadow`, `block_threshold_shadow`, …)
- Exclude `benchmark_source ILIKE 'CONTAMINATED%'` always.
- Prefer rows with ground truth: join `hal_ground_truth_labels` when present; else report “insufficient labels” and **do not invent thresholds**.
- Sean promotes shadow → live by explicit config copy after review.

### 4.2 Restart sequence (ops)

```text
Phase A — measure only (this PR)
  scripts/hal/shadow-threshold-autotune.ts --dry-run
  → report F1 / veto-rate on clean sources; proposed shadow values printed

Phase B — shadow write (flagged)
  HAL_SHADOW_AUTOTUNE_WRITE=true node ... --write-shadow
  → inserts update_type=shadow; upserts repid_config *shadow keys only

Phase C — optional wave restart (hyperdag-bench, separate cron)
  npm run bench:internal -- --n=50 --run-id=shadow-wave-$(date)
  source tag: wave-shadow-YYYY-MM-DD (never CONTAMINATED)
  exclude from promotion until GA labels / co-signs

Phase D — Sean promote
  UPDATE repid_config SET value = (SELECT value FROM repid_config WHERE key='hal_veto_threshold_shadow')
  WHERE key='hal_veto_threshold';  -- manual, reviewed
```

### 4.3 Exclusion + quality gates

| Gate | Rule |
|---|---|
| Contamination | Drop `CONTAMINATED%` sources |
| Mock / integration | Flag `cc-sprint-9-integration-test` as non-discriminative unless `hal_mode` is fact-check |
| Label floor | Require ≥30 high-confidence labels for threshold proposal (MINIMUM_VIABLE per brain id=39); else measure-only |
| Circular label ban | Do **not** use HAL’s own veto as ground truth |
| Bounds | Shadow veto must stay in [0.25, 0.70]; block in [veto+0.05, 0.85] |

### 4.4 Coordination with GA

- GA owns ground-truth pipeline (task #26 done on their PR).
- XC shadow autotune **reads** `hal_runner_results` + labels; does not compete for writers on live thresholds.
- Share proposed shadow values in `repid_experiment_log` phase=`hal_shadow_autotune`.

---

## 5. Delivered in this PR

| Artifact | Purpose |
|---|---|
| `scripts/hal/shadow-threshold-autotune.ts` | Dry-run by default; optional shadow writes |
| `migrations/2026-07-13-hal-shadow-threshold-keys.sql` | Additive seed for shadow config keys (not applied) |
| This doc | Full investigation + ops plan |

**Not delivered (out of lane / Sean-gated):** live cron on Railway, production threshold promotion, CONTAMINATED data repair.

---

## 6. Why-stopped summary (pasteable)

> Wave harness lives in **hyperdag-bench**; nightly is a **blocked scaffold**, not a cron. Last runner write **2026-06-24**. Autotuner as a closed loop **does not exist** — 99% of `hal_threshold_updates` are catch_count counters; last real veto move **2026-06-15**. Restart path = shadow keys + dry-run script + optional bench re-run with non-CONTAMINATED sources; Sean alone promotes to live.

---

## 7. Sources

- Brain id=39, id=41  
- Tables: `hal_runner_results`, `hal_threshold_updates`, `repid_config`, `hal_ground_truth_labels`  
- Repos: `hyperdag-bench`, `repid-engine` scripts/hal-eval + agents-external  
