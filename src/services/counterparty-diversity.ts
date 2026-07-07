/**
 * Anti-Sybil MVP (2026-07-07) — pure-logic mirror of the counterparty-diversity
 * tier floor, so the "simulated sockpuppets don't clear AUTONOMOUS" invariant is
 * EXECUTABLE in CI without mutating prod (the live gate is the SQL function
 * count_unique_counterparties + compute_tier(int,uuid); this TS mirror encodes
 * the SAME rule the migration 20260707120000_counterparty_exclude_simulated.sql
 * implements, and is the reference the SQL must match).
 *
 * Design: REPID_ECONOMIC_DESIGN_v1 §6 · T2 §1.5/§4 rank 2.
 *
 * A contract is SIMULATED when its linked settlement is_simulated=true, OR a
 * truthy is_simulated flag sits on metadata/payload (mirrors src/utils/truthy.ts
 * and src/services/validation-repid-delta.ts#contractIsSimulated).
 */
import { isTruthyFlag } from '../utils/truthy';

export interface DeliveredContractLike {
  buyer_agent_id: string;
  /** true iff the linked x402 settlement is simulated */
  settlement_is_simulated?: boolean | null;
  metadata?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}

/** Mirrors the SQL `contract_is_non_simulated`: real settlement AND no sim flag. */
export function contractIsNonSimulated(c: DeliveredContractLike): boolean {
  if (c.settlement_is_simulated === true) return false;
  if (isTruthyFlag(c.metadata?.['is_simulated'])) return false;
  if (isTruthyFlag(c.payload?.['is_simulated'])) return false;
  return true;
}

/**
 * Distinct counterparties for a provider. When `excludeSimulated` is true (the
 * config flag ON), a buyer counts only if it has >= 1 NON-simulated delivered
 * contract — mirroring the SQL. Default (false) counts all delivered buyers.
 */
export function countUniqueCounterparties(
  delivered: DeliveredContractLike[],
  excludeSimulated: boolean,
): number {
  const buyers = new Set<string>();
  for (const c of delivered) {
    if (excludeSimulated && !contractIsNonSimulated(c)) continue;
    buyers.add(c.buyer_agent_id);
  }
  return buyers.size;
}

// Counterparty tier floors — MUST mirror the deployed compute_tier(int,uuid)
// defaults (migration 20260523140000). Zero-demotion floor: est/earn ungated.
export const COUNTERPARTY_FLOORS = { vet_min: 2, auto_min: 2, est_min: 0, earn_min: 0 } as const;

function baseTier(repid: number): string {
  if (repid >= 8000) return 'VETERAN';
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'ESTABLISHED';
  if (repid >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

/** Mirror of compute_tier(p_repid, p_agent_id): score tier, then cascade down by
 *  the counterparty floor (sequential, so an agent can drop >1 tier). */
export function computeTierWithFloor(repid: number, cp: number): string {
  let tier = baseTier(repid);
  if (tier === 'VETERAN' && cp < COUNTERPARTY_FLOORS.vet_min) tier = 'AUTONOMOUS';
  if (tier === 'AUTONOMOUS' && cp < COUNTERPARTY_FLOORS.auto_min) tier = 'ESTABLISHED';
  if (tier === 'ESTABLISHED' && cp < COUNTERPARTY_FLOORS.est_min) tier = 'EARNING';
  if (tier === 'EARNING' && cp < COUNTERPARTY_FLOORS.earn_min) tier = 'PROBATIONARY';
  return tier;
}
