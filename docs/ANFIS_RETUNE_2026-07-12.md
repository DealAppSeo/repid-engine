# ANFIS Routing Re-tune — restart the frozen adaptation loop (task 21)

**Sprint:** sprint-2026-07-12-ecosystem · **Lane:** routing (CC exclusive) · **Date:** 2026-07-12
**Branch:** `feat/cc-2026-07-12-anfis-retune` · **Status:** code + migration + tests, **no prod merge**, loop **default-OFF**.

---

## 1. Diagnosis — why ANFIS routing is frozen (verified live 2026-07-12)

| Table | State (live) | Meaning |
|---|---|---|
| `execution_log` | 1569 rows, **max `created_at` = 2026-03-04** | trigger source is **dead** |
| `routing_weights` | 6 rows, **max `updated_at` = 2026-04-01** | never adapts |
| `anfis_params` | 3 rows, **last tuned 2026-03-04** | never adapts |
| `anfis_weight_history` | **0 rows** | no adaptation has ever been recorded |

**Chain of causation:**

1. `routing_weights` is fed only by the Postgres trigger **`sync_routing_weight`**, which is attached to **`execution_log`** (`INSERT` → upsert one `routing_weights` row).
2. `execution_log` inserts **stopped on 2026-03-04**. No service in the current tree writes it — its row shape (`agent_name`, `provider_name`, `was_free_tier`, `savings_usd`) belonged to an **older cost-logger that was superseded by the `llm_call_log` billing path** (`src/billing/log-call.ts`). The trigger is now **orphaned on a dead table**.
3. So `routing_weights` froze; `anfis_params`/`anfis_weight_history` — which would be written by a re-tune reading those weights — never moved.

**The obvious repair candidate does not work.** `anfis_provider_performance_lookup(domain, days)` reads
`repid_score_events.decision_outcome` and `metadata->>'latency_ms'`. Those columns are **not populated for
provider calls**: on the dominant domain, `('peer_verify', 30)` returns **only `deepseek`, `hit_rate ≈ 0.001`,
`avg_latency_ms = 0`, `avg_cost = 0`** (28 321 samples). Wiring the loop onto this RPC would write
**near-zero weights — worse than frozen.**

**The live, healthy feed is `llm_call_log`.** Every fact-check + adversarial-judge + router call logs here
with `provider`, `status` (`success|failed|rate_limited`), `latency_ms`, `cost_usd`, `created_at`. Verified
**fresh to now**, ~20 providers, tens of thousands of rows/day. Sample (7d):

| provider | success | failed | rate_limited | avg_latency (success) |
|---|---|---|---|---|
| mistral | 13 392 | 3 | 0 | 576 ms |
| gemini | 10 951 | 2 107 | 2 | 843 ms |
| groq | 10 612 | 8 932 | 0 | 730 ms |
| openrouter | 7 502 | 5 236 | 513 | 167 ms |
| cerebras | 6 644 | 1 104 | 3 | 1 292 ms |
| deepseek | 523 | 5 213 | 0 | 333 ms |

## 2. Fix — repoint the loop onto `llm_call_log` + add the periodic re-tune

Implements task 21 options **(b) repoint sync onto a live signal** and **(c) periodic ANFIS re-tune writing
`anfis_params` + `anfis_weight_history`**.

- **`migrations/2026-07-12-anfis-provider-health-rollup.sql`** — net-new, additive SQL function
  `anfis_provider_health_rollup(p_hours)` that GROUPs `llm_call_log` server-side into per-provider
  `{success, failed, rate_limited, samples, avg_latency_ms}`. (No existing table/trigger touched. Not applied
  to prod by this PR.)
- **`src/services/anfis-retune.ts`** — `retuneAnfisRouting(sb, opts)`:
  1. rolls up provider health over a window (default 24 h);
  2. computes each provider's new weight with the **same formula the orphaned trigger used** —
     `clamp(0.1 … 1.0, successRate · (1 − min(1, avgLatencyMs / 30 000)))` — so re-tuned weights live on the
     same scale as the historical ones;
  3. upserts `routing_weights` (`onConflict: provider`), appends one `anfis_weight_history` row per changed
     provider (`weight_before/after/delta`, `regime_type='provider_routing'`, `trigger_reason='anfis_retune_cron'`);
  4. writes one `anfis_params` row (`routing_accuracy` = mean success-rate, `training_samples` = total);
  5. reports **before/after to `ecosystem_loop_snapshots`** (`created_by='cc-anfis-retune'`).
- **`src/routes/v1/internal-cron.ts`** — new `POST /anfis-retune` trigger (~every 6 h), same token-gated
  idempotent pattern as the other UptimeRobot crons.

`rate_limited` counts against a provider's success-rate (transient failure). `fireworks` is denylisted
(account suspended). Providers below `ANFIS_RETUNE_MIN_SAMPLES` (default 20) in-window are skipped, not
zero-weighted.

## 3. Safety / reversibility

- **Default OFF** (`ANFIS_RETUNE_ENABLED`, default `false`). While off the runner is a **dry-run**: it
  COMPUTES the re-tune and can emit a report snapshot, but mutates **no** `routing_weights`/`anfis_params`/
  `anfis_weight_history` rows. Wiring the cron trigger is therefore inert until the flag is flipped.
- Routing weights steer **provider selection (cost/latency)**, **not** RepID scores or HAL vetoes — this is
  **not** a live-scoring/veto/threshold change (those remain Sean-gated).
- Additive only: one net-new SQL function; no change to existing tables/triggers. The orphaned
  `execution_log` trigger is left untouched (harmless).
- Env knobs: `ANFIS_RETUNE_ENABLED`, `ANFIS_RETUNE_WINDOW_HOURS` (24), `ANFIS_RETUNE_MIN_SAMPLES` (20).

## 4. Tests

`tests/anfis-retune.test.ts` (6 tests, all green): weight-formula continuity + clamps; dry-run writes
nothing; persist upserts weights + history (with before/after) + one params row + a snapshot; a
never-before-seen provider gets `weight_before = null`.

## 5. Promotion path (out of scope here — Sean/XC)

1. Apply `migrations/2026-07-12-anfis-provider-health-rollup.sql`.
2. Set `ANFIS_RETUNE_ENABLED=true` and point an UptimeRobot monitor at `POST /api/v1/internal-cron/anfis-retune`
   (`X-Cron-Token`).
3. Watch `ecosystem_loop_snapshots` (`created_by='cc-anfis-retune'`) + `anfis_weight_history` for the first
   real adaptation rows. Reversible instantly by flipping the flag back to `false`.
