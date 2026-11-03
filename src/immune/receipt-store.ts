/**
 * immune/receipt-store.ts — persist an immune combined receipt as APPEND-ONLY evidence + lifecycle events,
 * and re-verify an exported bundle WITHOUT trusting the database (M2, D-130).
 *
 * THE STATE INVARIANT (why this is an event log, not a flat table). A receipt being STORED, cryptographically
 * VALID, origin-AUTHENTICATED, outcome-VERIFIED, SETTLED, and ANCHORED are DIFFERENT states. A row whose mere
 * existence implied the strongest state is the evidence-laundering risk the P0 gate exists to stop. So the
 * evidence is immutable, every transition is a separate append-only EVENT, and state is DERIVED by folding
 * events — never inferred from the row. This module (the untrusted/slice path) records ONLY `recorded` and
 * `outcome_verified` / `verification_failed`. It NEVER emits `origin_authenticated` (P0), `settled` (M3) or
 * `anchored` (M4) — those are appended by the protected engine alone — so persistence here can never make a
 * receipt authoritative. The receipt's self-asserted `authoritative` field is stored as evidence and is NOT
 * trusted for state (is_authoritative is derived from an origin_authenticated event).
 *
 * INERT. Default OFF (IMMUNE_PERSIST_ENABLED). Disabled ⇒ dry-run: the record + events are returned and the
 * injected writer is never called. The real append-only DB insert is injected by the engine (ON CONFLICT DO
 * NOTHING on content_hash for idempotent dedup), so this module is testable offline with no DB.
 */
import {
  combinedReceiptContentHash,
  verifyCombinedReceipt,
  type SignedCombinedReceipt,
  type CombinedReceiptTrustRoots,
  type CombinedReceiptVerification,
} from './combined-receipt';

export type ImmuneReceiptEventType =
  | 'recorded'
  | 'outcome_verified'
  | 'verification_failed'
  | 'origin_authenticated'
  | 'policy_authorized'
  | 'settled'
  | 'anchored'
  | 'revoked'
  | 'superseded';

/** The M2 (untrusted-path) events. The rest are appended only by the protected engine. */
const M2_EVENTS: ReadonlySet<ImmuneReceiptEventType> = new Set(['recorded', 'outcome_verified', 'verification_failed']);

/** The immutable evidence row: flat bindings for querying, plus the full signed receipt for re-verification. */
export interface ImmuneReceiptRecord {
  content_hash: string;
  schema_version: string;
  experiment_id: string;
  mission_id: string | null;
  artifact_hash: string;
  result: string;
  settlement_outcome: string;
  mode: string;
  independence_class: string;
  maker_id: string | null;
  maker_controller: string | null;
  checker_id: string | null;
  evaluation_version: string | null;
  policy_digest: string | null;
  settlement_event_id: string | null;
  ruler: { oracle_set_id: string; hash: string } | null;
  /** the FULL signed combined receipt — hashes + signed attestations only, never raw artifacts or secrets. */
  receipt: SignedCombinedReceipt;
}

export interface ImmuneReceiptEvent {
  content_hash: string;
  event_type: ImmuneReceiptEventType;
  event_data: Record<string, unknown> | null;
  actor: string;
}

/** The current state, folded from events. Mirrors the SQL view `immune_receipt_state` exactly. */
export interface ReceiptState {
  content_hash: string | null;
  is_recorded: boolean;
  is_outcome_verified: boolean;
  is_origin_authenticated: boolean;
  is_policy_authorized: boolean;
  is_settled: boolean;
  is_anchored: boolean;
  is_revoked: boolean;
  is_superseded: boolean;
  /** DERIVED, never the receipt's own field: an origin_authenticated event, not revoked, not superseded. */
  is_authoritative: boolean;
}

export type RecordResult =
  | { persisted: boolean; refused?: undefined; record: ImmuneReceiptRecord; events: ImmuneReceiptEvent[] }
  | { persisted: false; refused: string[]; record?: undefined; events?: undefined };

/** Map a signed combined receipt to its immutable evidence row. Pure. */
export function buildReceiptRecord(receipt: SignedCombinedReceipt): ImmuneReceiptRecord {
  const mission = (receipt.sandbox_attestation?.payload as { mission_id?: unknown } | undefined)?.mission_id;
  return {
    content_hash: receipt.content_hash,
    schema_version: receipt.schema,
    experiment_id: receipt.experiment_id,
    mission_id: typeof mission === 'string' ? mission : null,
    artifact_hash: receipt.artifact_hash,
    result: receipt.result,
    settlement_outcome: receipt.settlement_outcome,
    mode: receipt.mode,
    independence_class: receipt.independence_class,
    maker_id: receipt.identities?.maker_id ?? null,
    maker_controller: receipt.identities?.maker_controller ?? null,
    checker_id: receipt.identities?.checker_id ?? null,
    evaluation_version: receipt.evaluation_version ?? null,
    policy_digest: receipt.policy_digest ?? null,
    settlement_event_id: receipt.settlement_event_id ?? null,
    ruler: receipt.ruler ? { oracle_set_id: receipt.ruler.oracle_set_id, hash: receipt.ruler.hash } : null,
    receipt,
  };
}

const persistEnabled = (): boolean => process.env['IMMUNE_PERSIST_ENABLED'] === '1';

/**
 * Record a receipt as append-only evidence + its M2 lifecycle events. Never throws. Fail-closed: a receipt
 * with no content_hash is refused (it is not evidence). A cryptographically INVALID receipt is still RECORDED
 * (forgery attempts are evidence too) but gets a `verification_failed` event, never `outcome_verified`.
 *
 * `verification` is the caller's verifyCombinedReceipt result (the caller holds the trust roots). `writeFn`,
 * when `enabled`, performs the real append-only insert; omit it / stay disabled for a dry-run.
 */
export function recordReceipt(
  receipt: SignedCombinedReceipt,
  verification: CombinedReceiptVerification,
  opts: { enabled?: boolean; actor?: string; writeFn?: (record: ImmuneReceiptRecord, events: ImmuneReceiptEvent[]) => void } = {},
): RecordResult {
  if (receipt == null || typeof receipt !== 'object' || typeof receipt.content_hash !== 'string') {
    return { persisted: false, refused: ['receipt_malformed'] };
  }
  const enabled = opts.enabled ?? persistEnabled();
  const actor = opts.actor ?? 'immune-slice';
  const record = buildReceiptRecord(receipt);

  const events: ImmuneReceiptEvent[] = [{ content_hash: record.content_hash, event_type: 'recorded', event_data: null, actor }];
  if (verification.ok) {
    events.push({ content_hash: record.content_hash, event_type: 'outcome_verified', event_data: null, actor });
  } else {
    events.push({ content_hash: record.content_hash, event_type: 'verification_failed', event_data: { reasons: verification.reasons }, actor });
  }

  if (enabled && opts.writeFn) opts.writeFn(record, events);
  return { persisted: Boolean(enabled && opts.writeFn), record, events };
}

/** Fold a receipt's events into its current state. Pure; mirrors the SQL view so offline state == DB state. */
export function currentState(events: readonly ImmuneReceiptEvent[]): ReceiptState {
  const has = (t: ImmuneReceiptEventType): boolean => events.some((e) => e.event_type === t);
  const is_origin_authenticated = has('origin_authenticated');
  const is_revoked = has('revoked');
  const is_superseded = has('superseded');
  return {
    content_hash: events[0]?.content_hash ?? null,
    is_recorded: has('recorded'),
    is_outcome_verified: has('outcome_verified'),
    is_origin_authenticated,
    is_policy_authorized: has('policy_authorized'),
    is_settled: has('settled'),
    is_anchored: has('anchored'),
    is_revoked,
    is_superseded,
    is_authoritative: is_origin_authenticated && !is_revoked && !is_superseded,
  };
}

export interface EvidenceBundle {
  receipt: SignedCombinedReceipt;
  events: ImmuneReceiptEvent[];
}

export interface BundleVerification {
  valid: boolean;
  state: ReceiptState;
  reasons: string[];
}

/**
 * Independently validate an EXPORTED evidence bundle without trusting the database or dashboard: recompute the
 * content hash, re-run verifyCombinedReceipt under the given roots (crypto + bindings + no recombination), bind
 * the events to the receipt, and check the state ordering is legitimate (no state may outrank its prerequisites).
 * `valid` requires the receipt verify AND the state be well-formed; an un-authoritative-but-valid bundle is fine.
 */
export function verifyEvidenceBundle(
  bundle: unknown,
  trustRoots: CombinedReceiptTrustRoots,
  seenExperimentIds: ReadonlySet<string> = new Set(),
): BundleVerification {
  const reasons: string[] = [];
  const empty: ReceiptState = {
    content_hash: null, is_recorded: false, is_outcome_verified: false, is_origin_authenticated: false,
    is_policy_authorized: false, is_settled: false, is_anchored: false, is_revoked: false, is_superseded: false, is_authoritative: false,
  };
  if (bundle == null || typeof bundle !== 'object') return { valid: false, state: empty, reasons: ['bundle_malformed'] };

  const { receipt, events } = bundle as EvidenceBundle;
  if (receipt == null || typeof receipt !== 'object' || typeof receipt.content_hash !== 'string' || !Array.isArray(events)) {
    return { valid: false, state: empty, reasons: ['bundle_malformed'] };
  }

  // content-hash integrity: a tampered body no longer hashes to the claimed id.
  if (receipt.content_hash !== combinedReceiptContentHash(receipt)) reasons.push('content_hash_tampered');

  // re-verify the receipt itself (does NOT trust the DB): crypto + every binding + recombination + replay.
  const v = verifyCombinedReceipt(receipt, trustRoots, seenExperimentIds);
  if (!v.ok) reasons.push(...v.reasons.map((r) => `receipt_invalid:${r}`));

  // every event must belong to THIS receipt.
  if (events.some((e) => e?.content_hash !== receipt.content_hash)) reasons.push('event_hash_mismatch');

  // state ordering: no state outranks its prerequisites.
  const state = currentState(events);
  if (state.is_settled && !state.is_outcome_verified) reasons.push('settled_without_verification');
  if (state.is_anchored && !state.is_authoritative) reasons.push('anchored_without_authority');
  if (state.is_authoritative && !state.is_outcome_verified) reasons.push('authoritative_without_verification');

  return { valid: reasons.length === 0, state, reasons };
}
