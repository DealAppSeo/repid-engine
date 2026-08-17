/**
 * routing-corpus.ts — turns joined (decision, outcome) rows into the matrix the LASSO eats.
 *
 * This is the second half of closing the adaptation loop. `routing-record-persist.ts`
 * writes the decision side keyed on (call_id, provider); `llm_call_log` already holds the
 * outcome side on the same two columns. This module is the pure function between the join
 * result and `fitLassoLogistic`, so the featurisation is testable without a database and
 * the fitting maths in scripts/eval/anfis-lasso.ts stays untouched.
 *
 * THE LEAKAGE RULE
 * ----------------
 * Every feature here is knowable BEFORE the provider is called. The outcome row
 * contributes the label and nothing else -- `latency_ms` and `cost_usd` are measured
 * after the call, so they are outcomes, not features, and they are deliberately absent
 * from the matrix. A fit that reads them would report a near-perfect model of a decision
 * it could not have made, which is the same class of error as scoring a skipped test as a
 * pass.
 *
 * `attempt` IS a legitimate feature: at decision time the router already knows the
 * exclusion set it was handed, so "this is the second try" is information it holds. It is
 * not information about how this try turned out.
 *
 * WHAT IS NOT IN HERE
 * -------------------
 * No prompt text, no ANFIS coefficients, no rule parameters, no scoring-formula terms.
 * Provider identity, chain shape, cost classes and skip-reason counts only.
 */

/** One row of the join: routing_decision_records LEFT JOIN llm_call_log on (call_id, provider). */
export interface JoinedRoutingRow {
  // --- decision side (routing_decision_records) ---
  call_id: string;
  provider: string;
  attempt: number;
  chosen_tier: string;
  chosen_cost_class: string;
  reason: string;
  chosen_position: number | null;
  chain_len: number;
  free_first_violated: boolean;
  n_free_usable: number;
  n_paid_usable: number;
  n_unhealthy: number;
  n_keyless: number;
  n_cap_hit: number;
  n_disabled: number;
  n_excluded: number;
  // --- outcome side (llm_call_log). Null when no outcome row was found. ---
  status: string | null;
}

/**
 * Feature names, in matrix-column order. Exported so the report labels the columns it
 * actually fitted rather than a hardcoded list that can drift from the builder.
 */
export const ROUTING_FEATURE_NAMES = [
  'attempt',
  'chosen_position',
  'chain_len',
  'free_first_violated',
  'n_free_usable',
  'n_paid_usable',
  'n_unhealthy',
  'n_keyless',
  'n_cap_hit',
  'n_disabled',
  'n_excluded',
  'cost_free',
  'cost_paid',
  'cost_unpriced',
  'tier_0a',
  'tier_1',
  'tier_slm',
  'reason_static_cost_order',
  'reason_anfis_escalation',
] as const;

export type RoutingFeatureName = (typeof ROUTING_FEATURE_NAMES)[number];

/**
 * A row is usable for fitting only if it carries a LABEL. A decision with no matching
 * outcome row is not a failure and must never be scored as one -- it is an unobserved
 * decision, and dropping it is the only honest handling.
 */
export function isLabelled(row: JoinedRoutingRow): boolean {
  return row.status !== null && row.status !== undefined && row.status !== '';
}

/** y = 1 iff the call succeeded. Every other status ('failed','rate_limited','cap_hit') is 0. */
export function labelOf(row: JoinedRoutingRow): number {
  return row.status === 'success' ? 1 : 0;
}

/**
 * `chosen_position` is null when the winner was not in the chain (exhausted chain). Null
 * means "not in the walk"; encoding it as 0 would claim it was FIRST, which inverts the
 * fact. Substitute the chain length instead -- one past the last real position, which is
 * the monotone continuation of "how deep did the walk go".
 */
function positionOf(row: JoinedRoutingRow): number {
  return row.chosen_position === null || row.chosen_position === undefined
    ? row.chain_len
    : row.chosen_position;
}

/** Feature vector for one joined row, in ROUTING_FEATURE_NAMES order. */
export function featurizeRoutingRow(row: JoinedRoutingRow): number[] {
  const cc = row.chosen_cost_class;
  const tier = row.chosen_tier;
  const reason = row.reason;
  return [
    row.attempt,
    positionOf(row),
    row.chain_len,
    row.free_first_violated ? 1 : 0,
    row.n_free_usable,
    row.n_paid_usable,
    row.n_unhealthy,
    row.n_keyless,
    row.n_cap_hit,
    row.n_disabled,
    row.n_excluded,
    cc === 'free' ? 1 : 0,
    cc === 'paid' ? 1 : 0,
    cc === 'unpriced' ? 1 : 0,
    tier === '0a' ? 1 : 0,
    tier === '1' ? 1 : 0,
    tier === 'slm' ? 1 : 0,
    reason === 'static_cost_order' ? 1 : 0,
    reason === 'anfis_escalation' ? 1 : 0,
  ];
}

export interface RoutingCorpus {
  X: number[][];
  y: number[];
  featureNames: string[];
  /** Rows supplied, before the unlabelled ones were dropped. */
  rowsIn: number;
  /** Rows dropped for having no outcome row. Reported, never silently absorbed. */
  droppedUnlabelled: number;
  /** Distinct providers seen among the KEPT rows. */
  providerCounts: Record<string, number>;
}

/**
 * Build the fit matrix. Unlabelled rows are dropped and COUNTED -- the count is part of the
 * result so a report can state the ruler ("N rows, M dropped") rather than a bare N.
 */
export function buildRoutingCorpus(rows: JoinedRoutingRow[]): RoutingCorpus {
  const X: number[][] = [];
  const y: number[] = [];
  const providerCounts: Record<string, number> = {};
  let dropped = 0;

  for (const row of rows) {
    if (!isLabelled(row)) {
      dropped++;
      continue;
    }
    X.push(featurizeRoutingRow(row));
    y.push(labelOf(row));
    providerCounts[row.provider] = (providerCounts[row.provider] ?? 0) + 1;
  }

  return {
    X,
    y,
    featureNames: [...ROUTING_FEATURE_NAMES],
    rowsIn: rows.length,
    droppedUnlabelled: dropped,
    providerCounts,
  };
}
