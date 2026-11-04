/**
 * immune/experimental-settlement.ts — settle a VERIFIED + AUTHORITATIVE immune combined receipt into the clean
 * experimental reputation path (M3, D-130). It REUSES src/services/experimental-repid.ts (the ExperimentalStore,
 * eligibilityFor, the row shape, the domain) rather than forking it, and writes ONLY to repid_experimental_events
 * (shadow/experimental) — never a canonical score.
 *
 * WHY THIS IS SAFE. The experimental surface already enforces, at the write path, everything M3 requires: a DB
 * CHECK blocks relabeling same-controller as independent, two UNIQUE constraints make each receipt's evidence
 * one-time (no concurrent double-award), the domain is separated (t12-exp-v1) and the mode is shadow. This module
 * adds the immune receipt as a new evidence_kind and defers to those guarantees; it does not re-implement them.
 *
 * THREE GATES, fail-closed, before anything settles:
 *   1. the receipt VERIFIES and is AUTHORITATIVE — only a receipt the engine authenticated (signature + config +
 *      authenticated ORIGIN, P0) may move reputation. A demo / unverified / un-authoritative receipt settles nothing.
 *   2. EXPERIMENTAL_REPID_MODE is shadow|active (off ⇒ nothing), AND the dedicated IMMUNE_SETTLE_ENABLED flag is on
 *      AND a store is injected — otherwise a DRY-RUN returns the would-write row and touches no table.
 *   3. independence is DERIVED here via eligibilityFor (the DB-backed owner check), never trusted from the receipt;
 *      same-controller can never become independent_counterparty by replay (the DB CHECK is the backstop).
 * The REAL owner verdict is also recorded as an owner-assurance TAG on the experimental event (owner-classes.ts):
 * verified|designated|none, metadata-only. It never alters `eligibility`, so a squad DESIGNATION can never be
 * mistaken for evidence-verified independence or move a real award.
 * Default (mode off / flag off / no store) is inert, and today nothing is authoritative (P0 not yet active), so this
 * is dry-run end to end until the owner activates the gates.
 */
import type { SignedCombinedReceipt, CombinedReceiptVerification } from './combined-receipt';
import {
  EXPERIMENTAL_DOMAIN, eligibilityFor, experimentalRepidMode,
  type ExperimentalEventRow, type ExperimentalStore, type Dimension, type Eligibility, type ExperimentalMode,
} from '../services/experimental-repid';
import { partyIndependence } from '../services/same-owner-settlement';
import { assessIndependence } from '../services/owner-classes';
import type { PartyIndependence } from '../scoring/grounding';

export const IMMUNE_EVIDENCE_KIND = 'immune_receipt';
export const IMMUNE_SCORING_VERSION = 'immune-receipt-v1';
/** The maker is scored for PRODUCING a correct, contained result. */
export const IMMUNE_DIMENSION: Dimension = 'producer';

/**
 * Precommitted immune-receipt-v1 delta: a verified-correct result is +1 producer competence, a verified-incorrect
 * is -1 (a LEGITIMATE negative settlement, never a success), not_scorable settles nothing. Magnitude is a scoring
 * knob versioned by IMMUNE_SCORING_VERSION — tune it only by cutting a new version, never by mutating this one.
 */
export function immuneDelta(result: string): number | null {
  if (result === 'correct') return 1;
  if (result === 'incorrect') return -1;
  return null;
}

export type ImmuneSettleResult =
  | { status: 'unverified'; reasons: string[] }
  | { status: 'not_authoritative' }
  | { status: 'off' }
  | { status: 'not_scorable' }
  | { status: 'dry_run'; row: ExperimentalEventRow }
  | { status: 'refused'; reason: string; detail?: string }
  | { status: 'settled'; mode: 'shadow' | 'active'; delta: number; score_after: number; eligibility: Eligibility };

/** Map a verified+authoritative immune receipt to an experimental event row. `agentId` is the maker resolved to a repid_agents uuid (the caller resolves it). Returns null when the result is not scorable. */
export function buildImmuneExperimentalRow(
  receipt: SignedCombinedReceipt, agentId: string, eligibility: Eligibility, mode: 'shadow' | 'active', counterpartyAgentId: string | null,
): ExperimentalEventRow | null {
  const delta = immuneDelta(receipt.result);
  if (delta === null) return null;
  // evidence_hash must be 64 lowercase hex (DB CHECK); content_hash is keccak256 (0x + 64 hex).
  const evidence_hash = String(receipt.content_hash).replace(/^0x/i, '').toLowerCase();
  return {
    domain: EXPERIMENTAL_DOMAIN, // forced to t12-exp-v1 by the table CHECK
    agent_id: agentId,
    dimension: IMMUNE_DIMENSION,
    evidence_kind: IMMUNE_EVIDENCE_KIND,
    evidence_id: receipt.content_hash, // one-time key: unique per receipt body
    evidence_ref: receipt.experiment_id,
    evidence_hash,
    oracle_id: receipt.ruler.oracle_set_id, // the answer-set the correctness was ruled against
    counterparty_agent_id: eligibility === 'independent_counterparty' ? counterpartyAgentId : null,
    eligibility,
    scoring_version: IMMUNE_SCORING_VERSION,
    mode,
    delta,
    metadata: { content_hash: receipt.content_hash, result: receipt.result, settlement_event_id: receipt.settlement_event_id, independence_class: receipt.independence_class, label: 'immune-combined-receipt' },
  };
}

const settleEnabled = (): boolean => process.env['IMMUNE_SETTLE_ENABLED'] === '1';

/**
 * Settle a verified, AUTHORITATIVE immune receipt into repid_experimental_events. Never throws. The authoritative
 * gate (1) is what ties this to P0: only a receipt the engine authenticated moves reputation. The real DB write is
 * the injected store's `insert` (ON the table's one-time UNIQUE constraints); default is dry-run.
 */
export async function settleImmuneReceipt(
  input: { receipt: SignedCombinedReceipt; verification: CombinedReceiptVerification; agentId: string; counterpartyAgentId?: string | null; squads?: { maker?: string | null; counterparty?: string | null } },
  deps: { store?: ExperimentalStore; mode?: ExperimentalMode; enabled?: boolean; independence?: Parameters<typeof eligibilityFor>[2] } = {},
): Promise<ImmuneSettleResult> {
  // (1) THE P0 GATE: only a verified + authoritative receipt may move reputation.
  if (!input.verification.ok) return { status: 'unverified', reasons: input.verification.reasons };
  if (input.verification.authoritative !== true) return { status: 'not_authoritative' };

  const mode = deps.mode ?? experimentalRepidMode();
  if (mode === 'off') return { status: 'off' };

  if (immuneDelta(input.receipt.result) === null) return { status: 'not_scorable' };

  // (3) independence DERIVED, never trusted from the receipt. Resolve the REAL owner verdict ONCE (the DB owner
  // check) and reuse it for BOTH the eligibility (the money path) and the owner-assurance tag (the experiment).
  const cp = input.counterpartyAgentId ?? null;
  const resolveIndependence = deps.independence ?? ((a: string, b: string) => partyIndependence(a, b));
  let real: PartyIndependence = 'owner_unknown';
  const eligibility = await eligibilityFor(input.agentId, cp, async (a, b) => (real = await resolveIndependence(a, b)));
  const row = buildImmuneExperimentalRow(input.receipt, input.agentId, eligibility, mode, cp);
  if (row === null) return { status: 'not_scorable' };
  if (row.oracle_id === input.agentId) return { status: 'refused', reason: 'self_dealing' };

  // OWNER-ASSURANCE (owner-classes, shadow/experiment-only): layer the squad DESIGNATION on top of the REAL
  // evidence verdict, honestly tagged, and record it as METADATA. Evidence always wins — a designation only fills
  // an owner_unknown gap and is tagged 'designated', NEVER 'verified'; a real same_owner is never laundered. This
  // never touches `eligibility`, so a designated pair can never become the evidence `independent_counterparty` that
  // gates a real award (that stays DB-CHECK-backed). The experiment reads metadata.owner_assurance; the canonical
  // award path reads eligibility — two different fields, deliberately.
  const assurance = assessIndependence(real, { squadId: input.squads?.maker }, { squadId: input.squads?.counterparty });
  row.metadata = { ...row.metadata, owner_assurance: assurance.assurance, owner_assurance_reason: assurance.reason, owner_independent: assurance.independent };

  // (2) inert unless explicitly enabled AND a store is injected: otherwise return the would-write, touch nothing.
  const enabled = deps.enabled ?? settleEnabled();
  if (!enabled || !deps.store) return { status: 'dry_run', row };

  const res = await deps.store.insert(row);
  if (!res.ok) return res.duplicate ? { status: 'refused', reason: 'already_consumed' } : { status: 'refused', reason: 'store_error', detail: res.error };
  return { status: 'settled', mode, delta: row.delta, score_after: res.score_after, eligibility };
}
