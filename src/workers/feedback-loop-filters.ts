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

import { hasTruthySimFlag } from '../utils/truthy';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Event types the FeedbackLoopWorker consumes from repid_events (the on-chain
 * outbox) to drive an ERC-8004 reputation write.
 *
 * Originally only the three x402/service settlement types. Broadened
 * (2026-07-02, feat/verify-redteam-repid-erc8004) to include the RepID-moving
 * VERIFICATION + RED-TEAM outbox events so that peer-verification and red-team
 * adjudication outcomes — which already move current_repid via the
 * repid_score_events trigger — also reach the chain. The worker writes a
 * *snapshot* of the agent's current_repid on each eligible outbox row; the
 * particular event_type only selects WHICH rows trigger a snapshot, so adding
 * types here is safe and additive (no per-type on-chain semantics change).
 *
 * Kept as a single exported constant so the SQL poll, the JS re-check, the
 * outbox emitters, and the unit tests all share one source of truth.
 */
export const ONCHAIN_ELIGIBLE_EVENT_TYPES = [
  // Settlement / payment loop (original)
  'x402_inbound_settled',
  'x402_outbound_settled',
  'service_fulfilled_settled',
  // Verification loop (peer-verification verdicts)
  'peer_verify_verified',
  'peer_verify_disputed',
  // Red-team adjudication loop (good catch / lazy subject / frivolous reject)
  'redteam_good_catch',
  'redteam_lazy_subject',
  'redteam_frivolous_reject',
] as const;

export type OnChainEligibleEventType = typeof ONCHAIN_ELIGIBLE_EVENT_TYPES[number];

// Placeholder / mock tx hashes: 0xmock..., 0xabc..., or 0x0000000000... (8+ zeros).
// F-series patch (2026-05-22): case-insensitive so 0xMOCK.../0xABC... also match.
export const MOCK_TX_RE = /^0x(mock|abc|0{8})/i;

/**
 * SQL fragment appended verbatim to the poll WHERE clause. Mirrors
 * isEligibleForOnChainWrite() exactly. Uses literals (no params) so it can be
 * concatenated after the parameterized `event_type = ANY($1)` predicate.
 */
export const POLL_EVENT_FILTER_SQL = `
         AND subject_type = 'agent'
         AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND lower(COALESCE(event_data->>'is_simulated', 'false')) NOT IN ('true', '1', 'yes')
         AND COALESCE(event_data->>'tx_hash', '') !~* '^0x(mock|abc|0{8})'
         AND COALESCE(event_data->>'drained_as_historical_mock', 'false') != 'true'
         AND COALESCE(event_data->>'drained_as_orphaned_conductor_format', 'false') != 'true'`;

export interface FilterableEvent {
  subject_type?: string | null;
  subject_id?: string | null;
  event_data?: Record<string, any> | null;
}

export type EligibilityReason =
  | 'subject_type_not_agent'
  | 'subject_id_not_uuid'
  | 'is_simulated'
  | 'mock_tx_hash'
  | 'drained_historical_mock'
  | 'drained_orphaned_conductor';

/**
 * Returns whether a polled repid_event may drive a REAL on-chain ERC-8004
 * write. is_simulated is normalized via hasTruthySimFlag (F-series patch
 * 2026-05-22): case/type variants ("True"/"TRUE"/1/"1"/"yes") and nested
 * flags are all caught; mock tx hashes now match case-insensitively.
 */
export function isEligibleForOnChainWrite(
  event: FilterableEvent
): { eligible: boolean; reason?: EligibilityReason } {
  const ed = event.event_data ?? {};
  if (event.subject_type !== 'agent') return { eligible: false, reason: 'subject_type_not_agent' };
  if (!event.subject_id || !UUID_RE.test(event.subject_id)) return { eligible: false, reason: 'subject_id_not_uuid' };
  if (hasTruthySimFlag(ed)) return { eligible: false, reason: 'is_simulated' };
  if (MOCK_TX_RE.test(String(ed.tx_hash ?? ''))) return { eligible: false, reason: 'mock_tx_hash' };
  if (String(ed.drained_as_historical_mock ?? 'false') === 'true') return { eligible: false, reason: 'drained_historical_mock' };
  if (String(ed.drained_as_orphaned_conductor_format ?? 'false') === 'true') return { eligible: false, reason: 'drained_orphaned_conductor' };
  return { eligible: true };
}
