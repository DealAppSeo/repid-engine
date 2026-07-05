/**
 * OUTPUT_PATH: src/services/anfis-replay-harness.ts
 *
 * Phase 0 — ANFIS Decisioning REPLAY / BACKTEST HARNESS (read-only over telemetry).
 * Bound spec: E:\dev\living-docs\03_specs\PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md (§7 refinements authoritative).
 *
 * WHAT THIS IS (and is NOT):
 *  - Reads the last-N-days of `llm_call_log` (verified schema below), paginated with a STRICT COUNT(*) equality
 *    assertion (R6): rows.length MUST equal COUNT(*), taken adjacent to the read and re-verified for stability.
 *  - For each real call it invokes the ACTUAL TS ANFIS core (`anfisRecommendProvider` from anfis-router.ts,
 *    which reuses the anfis-comma.ts 5-layer fuzzy forward pass) to get the route ANFIS WOULD have picked.
 *  - It scores prediction accuracy ONLY for the route ACTUALLY taken (the provider in the row) — the single
 *    honestly-scoreable comparison (R5 counterfactual honesty; §7 counterfactual-honesty). It NEVER scores
 *    hypothetical routes, and it NEVER claims "decisions beat baselines" — pre-exploration = prediction
 *    accuracy only.
 *  - NOTHING routes live traffic. This module performs ZERO writes. It is a pure read + compute + CSV emit.
 *
 * PREDICTION SOURCE (explicit, no theater):
 *  - The ANFIS forward pass emits a routing preference + confidence, NOT a cost/latency number.
 *  - The PREDICTED cost/latency/quality for a given (provider,tier) is a moving-average predictor built from
 *    the SAME telemetry substrate that `AnfisRoutingServiceHandler.computeFitnessScore` consumes at runtime
 *    (per-provider historical avg cost/latency + success-rate). The predictor is trained on the FIRST HALF of
 *    the window and evaluated on the SECOND HALF (temporal holdout) so predictions never see their own actuals.
 *  - `prediction_error` (R5: named prediction_error, NEVER regret) = |predicted - actual| per objective, for the
 *    provider actually taken. When there is NO predictor sample for an objective (e.g. the taken route had zero
 *    non-null latency rows in the training split), the prediction is emitted EMPTY and that objective is SKIPPED
 *    (honest "no predictor") — a fabricated 0 is NEVER scored.
 *
 * llm_call_log schema [V 2026-07-05 via Supabase MCP]:
 *   id uuid, call_id uuid, provider text, tier text, model text, prompt_tokens int, completion_tokens int,
 *   total_tokens int, cost_usd numeric, latency_ms int, user_id uuid, agent_id uuid, task_hint text,
 *   status text, error_message text, created_at timestamptz, quorum_id text
 */

import { db } from '../db';
import { anfisRecommendProvider, type AnfisRouterOutput } from './anfis-router';

export interface LlmCallRow {
  id: string;
  call_id: string | null;
  provider: string;
  tier: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number | null;
  cost_usd: number;
  latency_ms: number | null;
  task_hint: string | null;
  status: string;
  created_at: string;
}

// Per-(provider,tier) moving-average predictor, fit on the training split only.
// predCostUsd / predLatencyMs are null when there is NO sample for that objective (never a fabricated 0).
export interface ProviderModel {
  provider: string;
  tier: string;
  n: number;
  costN: number; // count of rows contributing to the cost mean
  predCostUsd: number | null; // mean cost_usd, or null when costN === 0
  latN: number; // count of non-null latency rows contributing to the latency mean
  predLatencyMs: number | null; // mean latency_ms (non-null only), or null when latN === 0
  predQuality: number; // success rate in [0,1] (always defined when n > 0)
}

export interface ReplayRow {
  id: string; // llm_call_log.id (uuid PK) — kept distinct from call_id
  call_id: string; // llm_call_log.call_id (real column; '' when null in source)
  created_at: string;
  provider_actual: string;
  tier_actual: string;
  model_actual: string;
  // ANFIS would-have-picked
  anfis_provider: string;
  anfis_tier: string;
  anfis_confidence: number;
  anfis_rule_weights: string; // JSON array
  anfis_lasso_features: string; // JSON array
  // predicted (moving-average model, keyed on the ACTUAL route — only honestly-scoreable one).
  // '' means NO prediction (no predictor sample) — distinct from a numeric 0.
  pred_cost_usd: number | '';
  pred_latency_ms: number | '';
  pred_quality: number | '';
  // actual outcomes
  actual_cost_usd: number;
  actual_latency_ms: number | '';
  actual_status: string;
  actual_quality: 0 | 1; // 1 iff status='success'
  // honest prediction error for the route ACTUALLY taken ('' = objective skipped, no predictor)
  prediction_error_cost: number | '';
  prediction_error_latency: number | '';
  prediction_error_quality: number | '';
  // decision timing
  decision_wall_time_ms: number;
}

const WINDOW_DAYS = 7;
const PAGE_SIZE = 1000; // Supabase hard-caps ~1000 rows/request; paginate all reads (R6)

// Provider-key delimiter. MUST be a string that cannot appear in a provider or tier value, so distinct
// (provider,tier) pairs can never collide. Used identically at model build AND lookup.
const KEY_DELIM = '||';
function providerKey(provider: string, tier: string): string {
  return `${provider}${KEY_DELIM}${tier}`;
}

/** COUNT(*) for the window (R6 strict-equality guard against silent truncation). */
export async function countWindow(windowDays = WINDOW_DAYS): Promise<number> {
  const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const { count, error } = await db
    .from('llm_call_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sinceIso);
  if (error) throw new Error(`countWindow failed: ${error.message}`);
  if (count == null) throw new Error('countWindow returned null count');
  return count;
}

/**
 * Read the FULL window, paginated. STRICT COUNT(*) assertion (R6).
 *
 * Race-honest protocol:
 *  - One COUNT is taken immediately BEFORE the read (adjacent, not the runReplay-level count).
 *  - After the read, we require rows.length === expected. If that fails it may be a genuine COUNT/read race
 *    (a row landing mid-read). We re-COUNT once; if the re-count now equals rows.length the window is stable
 *    and we accept it. Otherwise (rows.length matches neither the pre-count nor the post-count) we HARD-THROW.
 *  - There is NO drift tolerance: any unexplained mismatch fails loudly.
 */
export async function readWindow(windowDays = WINDOW_DAYS): Promise<LlmCallRow[]> {
  const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const expected = await countWindow(windowDays); // count taken adjacent to the read
  const rows: LlmCallRow[] = [];
  let from = 0;
  // Order by created_at,id for a stable pagination key.
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await db
      .from('llm_call_log')
      .select(
        'id, call_id, provider, tier, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, task_hint, status, created_at'
      )
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`readWindow page [${from},${to}] failed: ${error.message}`);
    const page = (data ?? []) as unknown as LlmCallRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    // Safety: never spin unbounded. A short page is the normal terminator; this is a backstop only.
    if (from > expected + PAGE_SIZE) break;
  }

  // STRICT COUNT assertion (R6): rows.length MUST equal COUNT(*). No tolerance.
  if (rows.length !== expected) {
    // Possible genuine race (row landed between COUNT and read). Re-count once and require stability.
    const recount = await countWindow(windowDays);
    if (rows.length !== recount) {
      throw new Error(
        `readWindow COUNT assertion FAILED: read ${rows.length} vs COUNT(*) ${expected} ` +
          `(re-count ${recount}); window unstable or truncated — refusing to proceed`
      );
    }
    // rows.length === recount: the window grew by exactly the rows we read; stable. Accept.
  }
  return rows;
}

/**
 * Fit per-(provider,tier) moving-average predictor on the TRAINING split (temporal holdout).
 * Only rows with non-null latency contribute to the latency mean; all rows contribute to cost + quality.
 * predCostUsd / predLatencyMs are null when their contributing count is zero — never a fabricated 0.
 */
export function fitProviderModels(train: LlmCallRow[]): Map<string, ProviderModel> {
  const acc = new Map<
    string,
    { provider: string; tier: string; n: number; costSum: number; costN: number; latSum: number; latN: number; succ: number }
  >();
  for (const r of train) {
    const key = providerKey(r.provider, r.tier);
    const a =
      acc.get(key) ??
      { provider: r.provider, tier: r.tier, n: 0, costSum: 0, costN: 0, latSum: 0, latN: 0, succ: 0 };
    a.n += 1;
    if (r.cost_usd != null) {
      a.costSum += Number(r.cost_usd) || 0;
      a.costN += 1;
    }
    if (r.latency_ms != null) {
      a.latSum += r.latency_ms;
      a.latN += 1;
    }
    if (r.status === 'success') a.succ += 1;
    acc.set(key, a);
  }
  const out = new Map<string, ProviderModel>();
  for (const [key, a] of acc) {
    out.set(key, {
      provider: a.provider,
      tier: a.tier,
      n: a.n,
      costN: a.costN,
      predCostUsd: a.costN ? a.costSum / a.costN : null,
      latN: a.latN,
      predLatencyMs: a.latN ? a.latSum / a.latN : null,
      predQuality: a.n ? a.succ / a.n : 0,
    });
  }
  return out;
}

/** Map an llm_call_log row to the ANFIS provider-state features. Uses model predictions as provider-state. */
function providerStateFor(model: ProviderModel | undefined): { cost: number; rate: number; qual: number } {
  if (!model) return { cost: 0.5, rate: 0.2, qual: 0.8 };
  // Normalize cost to [0,1] against a small nominal ceiling ($0.001/call is already "expensive" for tier-0a).
  // When there is no cost sample, fall back to the neutral nominal (0.5) rather than a fabricated 0.
  const cost = model.predCostUsd == null ? 0.5 : Math.min(1, model.predCostUsd / 0.001);
  const rate = 1 - model.predQuality; // pressure ~ failure rate
  return { cost, rate, qual: model.predQuality };
}

/**
 * Replay a single call through the ACTUAL ANFIS core and score prediction accuracy for the route TAKEN only.
 * Returns the ReplayRow + the measured decision wall-time in ms.
 */
export function replayOne(row: LlmCallRow, models: Map<string, ProviderModel>): ReplayRow {
  const actualKey = providerKey(row.provider, row.tier);
  const takenModel = models.get(actualKey);

  // ANFIS decision — MEASURE wall time around the real forward pass only.
  const t0 = process.hrtime.bigint();
  const anfis: AnfisRouterOutput = anfisRecommendProvider(
    row.task_hint || '',
    row.task_hint || undefined,
    providerStateFor(takenModel)
  );
  const t1 = process.hrtime.bigint();
  const decisionMs = Number(t1 - t0) / 1e6;

  const actualQuality: 0 | 1 = row.status === 'success' ? 1 : 0;

  // Predictions keyed on the ROUTE ACTUALLY TAKEN — the only honestly-scoreable comparison (R5/§7).
  // Emit '' (no prediction) when the objective has no predictor sample; never fabricate a 0.
  const predCost: number | '' =
    takenModel && takenModel.predCostUsd != null ? takenModel.predCostUsd : '';
  const predLat: number | '' =
    takenModel && takenModel.predLatencyMs != null ? takenModel.predLatencyMs : '';
  const predQual: number | '' = takenModel ? takenModel.predQuality : '';

  const actualCost = Number(row.cost_usd) || 0;
  const actualLat = row.latency_ms == null ? ('' as const) : row.latency_ms;

  return {
    id: row.id,
    call_id: row.call_id ?? '',
    created_at: row.created_at,
    provider_actual: row.provider,
    tier_actual: row.tier,
    model_actual: row.model,
    anfis_provider: anfis.recommendedProvider,
    anfis_tier: anfis.recommendedTier,
    anfis_confidence: anfis.confidence,
    anfis_rule_weights: JSON.stringify(anfis.ruleWeights ?? []),
    anfis_lasso_features: JSON.stringify(anfis.lassoSelectedFeatures ?? []),
    pred_cost_usd: predCost,
    pred_latency_ms: predLat === '' ? '' : Math.round(predLat as number),
    pred_quality: predQual === '' ? '' : Number((predQual as number).toFixed(4)),
    actual_cost_usd: actualCost,
    actual_latency_ms: actualLat,
    actual_status: row.status,
    actual_quality: actualQuality,
    // Skip scoring an objective when it has no prediction OR no actual — never score a fabricated value.
    prediction_error_cost: predCost === '' ? '' : Math.abs((predCost as number) - actualCost),
    prediction_error_latency:
      predLat === '' || actualLat === '' ? '' : Math.abs((predLat as number) - (actualLat as number)),
    prediction_error_quality: predQual === '' ? '' : Math.abs((predQual as number) - actualQuality),
    decision_wall_time_ms: decisionMs,
  };
}

export const CSV_COLUMNS: (keyof ReplayRow)[] = [
  'id',
  'call_id',
  'created_at',
  'provider_actual',
  'tier_actual',
  'model_actual',
  'anfis_provider',
  'anfis_tier',
  'anfis_confidence',
  'anfis_rule_weights',
  'anfis_lasso_features',
  'pred_cost_usd',
  'pred_latency_ms',
  'pred_quality',
  'actual_cost_usd',
  'actual_latency_ms',
  'actual_status',
  'actual_quality',
  'prediction_error_cost',
  'prediction_error_latency',
  'prediction_error_quality',
  'decision_wall_time_ms',
];

function csvCell(v: unknown): string {
  if (v === '' || v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ReplayRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

/** Percentile of a numeric array (linear interpolation). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export interface ReplaySummary {
  windowDays: number;
  countAsserted: number;
  rowsRead: number;
  trainRows: number;
  evalRows: number;
  emittedRows: number;
  decisionMsP50: number;
  decisionMsP95: number;
  decisionMsP99: number;
  actualLatencyMsP50: number;
  actualLatencyMsP95: number;
  // mean absolute prediction error per objective over eval rows with a model
  maeCost: number;
  maeLatency: number;
  maeQuality: number;
  scoredCost: number;
  scoredLatency: number;
  scoredQuality: number;
  // rows that got NO prediction for an objective (honest skips) — the complement of scored*
  skippedCost: number;
  skippedLatency: number;
  skippedQuality: number;
}

/**
 * Full replay over the window. Temporal holdout: fit models on first half, evaluate on second half.
 * READ-ONLY. Returns rows + summary; the caller writes the CSV to disk.
 */
export async function runReplay(windowDays = WINDOW_DAYS): Promise<{ rows: ReplayRow[]; summary: ReplaySummary }> {
  // readWindow performs its own adjacent, strict COUNT(*) assertion. Report the same asserted count
  // (a single count taken inside the read path) rather than a second, race-widening count here.
  const all = await readWindow(windowDays);
  const countAsserted = all.length;
  // Temporal split by created_at midpoint of the read set (already time-ordered).
  const mid = Math.floor(all.length / 2);
  const train = all.slice(0, mid);
  const evalSet = all.slice(mid);
  const models = fitProviderModels(train);

  const rows = evalSet.map((r) => replayOne(r, models));

  const decisionTimes = rows.map((r) => r.decision_wall_time_ms);
  const actualLats = rows.map((r) => r.actual_latency_ms).filter((v): v is number => v !== '');
  const errCost = rows.map((r) => r.prediction_error_cost).filter((v): v is number => v !== '');
  const errLat = rows.map((r) => r.prediction_error_latency).filter((v): v is number => v !== '');
  const errQual = rows.map((r) => r.prediction_error_quality).filter((v): v is number => v !== '');
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

  const summary: ReplaySummary = {
    windowDays,
    countAsserted,
    rowsRead: all.length,
    trainRows: train.length,
    evalRows: evalSet.length,
    emittedRows: rows.length,
    decisionMsP50: percentile(decisionTimes, 50),
    decisionMsP95: percentile(decisionTimes, 95),
    decisionMsP99: percentile(decisionTimes, 99),
    actualLatencyMsP50: percentile(actualLats, 50),
    actualLatencyMsP95: percentile(actualLats, 95),
    maeCost: mean(errCost),
    maeLatency: mean(errLat),
    maeQuality: mean(errQual),
    scoredCost: errCost.length,
    scoredLatency: errLat.length,
    scoredQuality: errQual.length,
    skippedCost: rows.length - errCost.length,
    skippedLatency: rows.length - errLat.length,
    skippedQuality: rows.length - errQual.length,
  };

  return { rows, summary };
}
