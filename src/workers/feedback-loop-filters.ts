/**
 * Defensive filters for the FeedbackLoopWorker poll (2026-05-22).
 *
 * Sean drained 990 stale rows from repid_events pre-merge (10 historical mock
 * x402 events + 980 orphaned conductor-format rows). Without filters in the
 * worker, future mock/simulated/orphaned events could re-accumulate and burn
 * REAL gas writing fake attestations on-chain. These filters prevent that.
 *
 * Two layers, intentionally kept in sync in this one file:
 *   1. POLL_EVENT_FILTER_SQL — appended to the Postgres poll SELECT (primary
 *      gate; the DB never even returns disqualified rows).
 *   2. isEligibleForOnChainWrite() — a pure JS re-check applied to every polled
 *      row (defense-in-depth: catches anything if the SQL is ever relaxed, and
 *      is the unit-tested surface). Side-effect-free so tests import it without
 *      booting db/config.
 *
 * If you change one layer, change the other to match.
 */

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Placeholder / mock tx hashes: 0xmock..., 0xabc..., or 0x0000000000... (8+ zeros).
export const MOCK_TX_RE = /^0x(mock|abc|0{8})/;

/**
 * SQL fragment appended verbatim to the poll WHERE clause. Mirrors
 * isEligibleForOnChainWrite() exactly. Uses literals (no params) so it can be
 * concatenated after the parameterized `event_type = ANY($1)` predicate.
 */
export const POLL_EVENT_FILTER_SQL = `
         AND subject_type = 'agent'
         AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND COALESCE(event_data->>'is_simulated', 'false') != 'true'
         AND COALESCE(event_data->>'tx_hash', '') !~ '^0x(mock|abc|0{8})'
         AND COALESCE(event_data->>'drained_as_historical_mock', 'false') != 'true'
         AND COALESCE(event_data->>'drained_as_orphaned_conductor_format', 'false') != 'true'`;

export interface FilterableEvent {
  subject_type?: string | null;
  subject_id?: string | null;
  event_data?: Record<string, any> | null;
  verdict_x402?: string | null;
  verdict_hal?: string | null;
}

export type EligibilityReason =
  | 'subject_type_not_agent'
  | 'subject_id_not_uuid'
  | 'is_simulated'
  | 'mock_tx_hash'
  | 'drained_historical_mock'
  | 'drained_orphaned_conductor'
  | 'x402_not_settled'
  | 'hal_not_pass';

/**
 * Returns whether a polled repid_event may drive a REAL on-chain ERC-8004
 * write. `String(...)` coercion handles both JSON booleans (true) and the
 * Postgres `->>` text form ('true') uniformly.
 */
export function isEligibleForOnChainWrite(
  event: FilterableEvent
): { eligible: boolean; reason?: EligibilityReason } {
  const ed = event.event_data ?? {};
  if (event.subject_type !== 'agent') return { eligible: false, reason: 'subject_type_not_agent' };
  if (!event.subject_id || !UUID_RE.test(event.subject_id)) return { eligible: false, reason: 'subject_id_not_uuid' };
  if (String(ed.is_simulated ?? 'false') === 'true') return { eligible: false, reason: 'is_simulated' };
  if (MOCK_TX_RE.test(String(ed.tx_hash ?? ''))) return { eligible: false, reason: 'mock_tx_hash' };
  if (String(ed.drained_as_historical_mock ?? 'false') === 'true') return { eligible: false, reason: 'drained_historical_mock' };
  if (String(ed.drained_as_orphaned_conductor_format ?? 'false') === 'true') return { eligible: false, reason: 'drained_orphaned_conductor' };

  // Parallel-verdict gate (2026-05-22): on-chain write requires BOTH the x402
  // settlement AND the HAL judgment to agree — either dissent vetoes. Env-gated
  // (default OFF) so merging this can't halt existing worker writes before the
  // migration + HAL judgment worker are live. Enable order: apply the verdict
  // migration → HAL_JUDGMENT_WORKER_ENABLED=true → REQUIRE_DUAL_VERDICT=true.
  // Rows that fail this gate are recorded off-chain (marked processed by the
  // worker) and earn NO gas — exactly the gas rule.
  if (process.env.REQUIRE_DUAL_VERDICT === 'true') {
    if (event.verdict_x402 !== 'settled') return { eligible: false, reason: 'x402_not_settled' };
    if (event.verdict_hal !== 'pass') return { eligible: false, reason: 'hal_not_pass' };
  }
  return { eligible: true };
}
