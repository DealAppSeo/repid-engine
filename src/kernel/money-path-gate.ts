/**
 * money-path-gate.ts — map an economic score event onto the Policy Gate.
 *
 * The money path (`scoring/pipeline.ts::applyValidationEvent`) applied a RAW
 * caller-supplied delta straight to current_repid with a placeholder HAL score
 * and no quorum/purpose gate (authority audit 2026-09-03, the 🔴 leak). This
 * helper is the single, testable seam that turns an economic event's real
 * evidence into an EvidenceBundle and asks the deterministic gate what may move.
 *
 * SHADOW-FIRST: the caller records the result and, in shadow mode, changes
 * nothing. In enforce mode it applies ONLY `authorized_delta`. Enforce requires
 * the trust_receipts table (settled_receipt_id) and a measurement window.
 */
import { gate, GateResult, HalEvidence } from './policy-gate';

export interface EconomicMoveInput {
  /** The economic delta the settlement path computed (may be + or -). */
  delta: number;
  /** The settled Trust Receipt id, once the trust_receipts table exists. */
  settled_receipt_id?: string | null;
  /** Real HAL evidence for the event, when it ran one (usually absent for pure settlements). */
  hal?: HalEvidence;
  /** Deterministic settlement confirmation: x402 settled AND delivery verified. */
  settlement_confirmed: boolean;
  /** Subject reputation lens: direct settled episodes + uncertainty. */
  subject_n: number;
  subject_u: number;
  /** A real deliverable (service fulfilment) vs an internal chore. */
  is_deliverable: boolean;
  /** 0..5; economic settlements are typically low-risk/reversible unless flagged. */
  risk_class?: number;
}

export function evaluateEconomicMove(i: EconomicMoveInput): GateResult {
  return gate({
    action_class: 'durable_repid_move',
    risk_class: i.risk_class ?? 1,
    proposed_delta: i.delta,
    settled_receipt_id: i.settled_receipt_id ?? null,
    hal: i.hal,
    // A confirmed settlement is deterministic reward evidence (see policy-gate §3e).
    sensors: { tests_passed: i.settlement_confirmed },
    repid: { n: i.subject_n, u: i.subject_u },
    purpose: { is_deliverable: i.is_deliverable },
  });
}

export type MoneyPathGateMode = 'off' | 'shadow' | 'enforce';

/** Resolved gate mode for the money path. Default `shadow` — measure, never
 *  silently enforce, and never guess `enforce` from a typo. */
export function moneyPathGateMode(): MoneyPathGateMode {
  const m = (process.env.MONEY_PATH_GATE_MODE || 'shadow').trim().toLowerCase();
  return m === 'off' || m === 'enforce' ? (m as MoneyPathGateMode) : 'shadow';
}
