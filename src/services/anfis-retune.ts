/**
 * anfis-retune.ts — restart the ANFIS routing-adaptation loop (CC, task 21, 2026-07-12).
 *
 * WHY THIS EXISTS
 * ---------------
 * The ANFIS intelligent-routing loop is FROZEN. Root cause (verified live 2026-07-12):
 *
 *   - `execution_log` is the trigger source for `routing_weights` (via the Postgres
 *     trigger `sync_routing_weight`). It STOPPED receiving inserts on 2026-03-04
 *     (1569 rows, none since). No service in the current tree writes it — the row
 *     shape (agent_name/provider_name/was_free_tier/savings_usd) belonged to an old
 *     cost-logger that was superseded by the `llm_call_log` billing path
 *     (`src/billing/log-call.ts`). The trigger is orphaned on a dead table.
 *   - Consequently `routing_weights` last moved 2026-04-01, `anfis_params` last tuned
 *     2026-03-04, and `anfis_weight_history` has 0 rows — nothing adapts.
 *   - The obvious candidate feed, `anfis_provider_performance_lookup()`, technically
 *     works but is DEGENERATE for the dominant domains: it reads
 *     `repid_score_events.decision_outcome` + a `metadata->>latency_ms` that are not
 *     populated for provider calls (peer_verify/30d → only deepseek clears the
 *     COUNT>=5 gate, hit_rate ≈ 0.001, avg_latency/cost = 0). Wiring it in would
 *     write near-zero weights — worse than frozen.
 *
 * THE LIVE, HEALTHY SIGNAL is `llm_call_log`: every fact-check + adversarial-judge +
 * router call logs here with `provider`, `status` (success|failed|rate_limited),
 * `latency_ms`, `cost_usd`, `created_at`. Verified fresh to now, ~20 providers,
 * tens of thousands of rows/day. This module REPOINTS the ANFIS adaptation loop onto
 * that feed (task 21 option (b) "repoint sync onto a live signal") and adds the
 * periodic re-tune (option (c)) that writes `anfis_params` + `anfis_weight_history`.
 *
 * WHAT IT DOES (per run)
 * ----------------------
 *   1. Roll up `llm_call_log` over a window (default 24h) per provider →
 *      {success, failed, rate_limited, samples, avg_latency_ms} via the SQL function
 *      `anfis_provider_health_rollup(p_hours)` (migration shipped with this PR).
 *   2. Compute a new routing weight per provider using the SAME formula the orphaned
 *      `sync_routing_weight` trigger used, so behavior is continuous with history:
 *          successRate * (1 - min(1, avgLatencyMs / 30000)), clamped to [0.1, 1.0].
 *   3. Read BEFORE weights, upsert AFTER weights into `routing_weights`, and append one
 *      `anfis_weight_history` row per changed provider (weight_before/after/delta).
 *   4. Write one `anfis_params` row capturing the re-tune (routing_accuracy = mean
 *      successRate, training_samples = total samples).
 *   5. Report BEFORE/AFTER to `ecosystem_loop_snapshots` (task 21 reporting channel).
 *
 * SAFETY / REVERSIBILITY
 * ----------------------
 *   - Gated behind `ANFIS_RETUNE_ENABLED` (default OFF). When off, callers get a
 *     dry-run: everything is COMPUTED and the before/after is returned + (optionally)
 *     a snapshot is written, but NO routing_weights/params/history rows are mutated.
 *   - Routing weights steer PROVIDER SELECTION (cost/latency), not RepID scores or HAL
 *     vetoes — this is not a "live scoring/veto/threshold change" (those stay Sean-gated).
 *   - Pure, additive, no schema change to existing tables. One net-new SQL function
 *     ships as a migration in this PR (not applied to prod here — no prod merge).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Providers we never want the re-tune to (re)introduce as routable — suspended/aliases. */
const PROVIDER_DENYLIST = new Set(['fireworks']);

export interface ProviderHealthRollup {
  provider: string;
  success: number;
  failed: number;
  rate_limited: number;
  samples: number;
  avg_latency_ms: number;
}

export interface ProviderRetune {
  provider: string;
  samples: number;
  success_rate: number;
  avg_latency_ms: number;
  weight_before: number | null;
  weight_after: number;
  delta: number;
}

export interface RetuneResult {
  ran_at: string;
  window_hours: number;
  source: 'llm_call_log';
  enabled: boolean;
  persisted: boolean;
  min_samples: number;
  providers: ProviderRetune[];
  skipped: Array<{ provider: string; reason: string; samples: number }>;
  training_samples: number;
  routing_accuracy: number; // mean success_rate across retuned providers
  wrote: { routing_weights: number; weight_history: number; anfis_params: number; snapshot: boolean };
}

export interface RetuneOptions {
  windowHours?: number;
  /** Force dry-run regardless of the env flag (persist=false). Default: follow ANFIS_RETUNE_ENABLED. */
  persist?: boolean;
  /** Minimum samples in-window before a provider is (re)weighted. Default 20 (env ANFIS_RETUNE_MIN_SAMPLES). */
  minSamples?: number;
  /** Correlate all rows written by this run. Caller may pass one; else a uuid is generated. */
  cycleId?: string;
}

export function retuneEnabled(): boolean {
  return process.env.ANFIS_RETUNE_ENABLED === 'true';
}

/**
 * Continuity formula — identical to the orphaned `sync_routing_weight` trigger so the
 * re-tuned weights live on the same scale as the historical ones.
 *   weight = clamp(0.1 .. 1.0, successRate * (1 - min(1, avgLatencyMs / 30000)))
 */
export function computeWeight(successRate: number, avgLatencyMs: number): number {
  const latencyPenalty = 1 - Math.min(1, (avgLatencyMs || 0) / 30_000);
  const raw = successRate * latencyPenalty;
  return Math.max(0.1, Math.min(1.0, raw));
}

function uuid(): string {
  // Node >=20 has crypto.randomUUID on the global.
  return (globalThis as any).crypto?.randomUUID?.() ?? require('crypto').randomUUID();
}

/**
 * Roll up llm_call_log per provider over the window. Uses the SQL function
 * `anfis_provider_health_rollup(p_hours)` (does the GROUP BY server-side so we never
 * page tens of thousands of rows through supabase-js). Returns [] on any error.
 */
export async function fetchProviderHealth(sb: SupabaseClient, windowHours: number): Promise<ProviderHealthRollup[]> {
  const { data, error } = await sb.rpc('anfis_provider_health_rollup', { p_hours: windowHours });
  if (error) {
    console.error('[anfis-retune] anfis_provider_health_rollup rpc failed:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    provider: String(r.provider),
    success: Number(r.success) || 0,
    failed: Number(r.failed) || 0,
    rate_limited: Number(r.rate_limited) || 0,
    samples: Number(r.samples) || 0,
    avg_latency_ms: Number(r.avg_latency_ms) || 0,
  }));
}

/**
 * Re-tune ANFIS routing weights from the live llm_call_log feed. See file header.
 */
export async function retuneAnfisRouting(sb: SupabaseClient, opts: RetuneOptions = {}): Promise<RetuneResult> {
  const ran_at = new Date().toISOString();
  const windowHours = opts.windowHours ?? (Number(process.env.ANFIS_RETUNE_WINDOW_HOURS) || 24);
  const minSamples = opts.minSamples ?? (Number(process.env.ANFIS_RETUNE_MIN_SAMPLES) || 20);
  const cycleId = opts.cycleId ?? uuid();
  // persist only when explicitly requested AND the feature is enabled. opts.persist===false forces dry-run.
  const persist = opts.persist === false ? false : (opts.persist === true ? true : retuneEnabled());

  const health = await fetchProviderHealth(sb, windowHours);

  // BEFORE snapshot of routing_weights.
  const { data: beforeRows } = await sb.from('routing_weights').select('provider, weight');
  const beforeByProvider = new Map<string, number>((beforeRows ?? []).map((r: any) => [String(r.provider), Number(r.weight)]));

  const providers: ProviderRetune[] = [];
  const skipped: Array<{ provider: string; reason: string; samples: number }> = [];

  for (const h of health) {
    if (PROVIDER_DENYLIST.has(h.provider)) { skipped.push({ provider: h.provider, reason: 'denylisted', samples: h.samples }); continue; }
    if (h.samples < minSamples) { skipped.push({ provider: h.provider, reason: `below_min_samples(${minSamples})`, samples: h.samples }); continue; }
    // rate_limited is a transient failure for weighting purposes (counts against success rate).
    const attempts = h.success + h.failed + h.rate_limited;
    const successRate = attempts > 0 ? h.success / attempts : 0;
    const weightAfter = computeWeight(successRate, h.avg_latency_ms);
    const weightBefore = beforeByProvider.has(h.provider) ? beforeByProvider.get(h.provider)! : null;
    providers.push({
      provider: h.provider,
      samples: h.samples,
      success_rate: +successRate.toFixed(4),
      avg_latency_ms: Math.round(h.avg_latency_ms),
      weight_before: weightBefore,
      weight_after: +weightAfter.toFixed(4),
      delta: +(weightAfter - (weightBefore ?? weightAfter)).toFixed(4),
    });
  }

  const training_samples = providers.reduce((s, p) => s + p.samples, 0);
  const routing_accuracy = providers.length ? +(providers.reduce((s, p) => s + p.success_rate, 0) / providers.length).toFixed(4) : 0;

  const wrote = { routing_weights: 0, weight_history: 0, anfis_params: 0, snapshot: false };

  if (persist && providers.length) {
    // 1. Upsert routing_weights (provider is unique — matches the trigger's ON CONFLICT (provider)).
    const now = new Date().toISOString();
    for (const p of providers) {
      const h = health.find((x) => x.provider === p.provider)!;
      const attempts = h.success + h.failed + h.rate_limited;
      const { error } = await sb.from('routing_weights').upsert({
        provider: p.provider,
        success_count: h.success,
        failure_count: h.failed + h.rate_limited,
        total_latency_ms: Math.round(h.avg_latency_ms) * Math.max(1, attempts),
        avg_latency_ms: Math.round(h.avg_latency_ms),
        weight: p.weight_after,
        updated_at: now,
      }, { onConflict: 'provider' });
      if (!error) wrote.routing_weights++;
      else console.error(`[anfis-retune] routing_weights upsert failed (${p.provider}):`, error.message);
    }

    // 2. anfis_weight_history — one row per provider whose weight actually moved.
    const historyRows = providers
      .filter((p) => p.weight_before === null || Math.abs(p.delta) > 1e-6)
      .map((p) => ({
        agent_id: p.provider, // provider name occupies the agent_id slot (routing regime, not an agent)
        regime_type: 'provider_routing',
        asset: 'llm',
        weight_before: p.weight_before,
        weight_after: p.weight_after,
        delta: p.delta,
        trigger_cycle_id: cycleId,
        trigger_reason: 'anfis_retune_cron',
        exploration_method: 'llm_call_log_rollup',
        approved_by: 'anfis-retune',
      }));
    if (historyRows.length) {
      const { error } = await sb.from('anfis_weight_history').insert(historyRows);
      if (!error) wrote.weight_history = historyRows.length;
      else console.error('[anfis-retune] anfis_weight_history insert failed:', error.message);
    }

    // 3. anfis_params — capture the re-tune as a tunable-param row.
    const { error: paramErr } = await sb.from('anfis_params').insert({
      param_name: 'routing_retune',
      value: routing_accuracy,
      routing_accuracy,
      training_samples,
    });
    if (!paramErr) wrote.anfis_params = 1;
    else console.error('[anfis-retune] anfis_params insert failed:', paramErr.message);
  }

  // 4. Report BEFORE/AFTER via ecosystem_loop_snapshots (always attempted unless persist explicitly false).
  const snapshotWanted = opts.persist !== false;
  if (snapshotWanted) {
    const before = Object.fromEntries([...beforeByProvider.entries()]);
    const after = Object.fromEntries(providers.map((p) => [p.provider, p.weight_after]));
    const { error } = await sb.from('ecosystem_loop_snapshots').insert({
      metrics: {
        loop: 'anfis_routing_retune',
        source: 'llm_call_log',
        window_hours: windowHours,
        enabled: retuneEnabled(),
        persisted: persist,
        cycle_id: cycleId,
        training_samples,
        routing_accuracy,
        before_weights: before,
        after_weights: after,
        providers,
        skipped,
      },
      created_by: 'cc-anfis-retune',
    });
    wrote.snapshot = !error;
    if (error) console.error('[anfis-retune] ecosystem_loop_snapshots insert failed:', error.message);
  }

  console.log(`[anfis-retune] ran window=${windowHours}h enabled=${retuneEnabled()} persist=${persist} providers=${providers.length} samples=${training_samples} acc=${routing_accuracy} wrote=${JSON.stringify(wrote)}`);

  return {
    ran_at,
    window_hours: windowHours,
    source: 'llm_call_log',
    enabled: retuneEnabled(),
    persisted: persist,
    min_samples: minSamples,
    providers,
    skipped,
    training_samples,
    routing_accuracy,
    wrote,
  };
}

/** Cron-runner adapter (matches the (sb, opts) shape used by internal-cron.ts handlers). */
export async function retuneAnfisRoutingRunner(sb: SupabaseClient, opts: { persist?: boolean } = {}) {
  return retuneAnfisRouting(sb, { persist: opts.persist });
}
