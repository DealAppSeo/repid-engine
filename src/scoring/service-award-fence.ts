/**
 * scoring/service-award-fence.ts — decide whether a SERVICE_* award may move CANONICAL RepID (M3b, D-130).
 *
 * THE FINDING (verified in code + DB, 2026-11-03). `SERVICE_FULFILLED` moves canonical repid_agents.current_repid
 * +10/+5 for a contract merely being *fulfilled* (validation-repid-delta.ts:162: "clean transaction occurred,
 * regardless of quality"); `SERVICE_SATISFIED`/`SERVICE_OUTCOME` move it from a buyer's self-reported rating. These
 * awards carry NO idempotency key (replayable), their independence is gated only by SAME_OWNER_SETTLEMENT_MODE
 * (default OFF ⇒ independence unknown), and canonical RepID is then read by x402-gate.ts:187 as spend authority with
 * zero collateral for high tiers. So execution / self-report becomes uncollateralized money authority.
 *
 * THE FENCE. A SERVICE_* award may move CANONICAL score only when ALL hold: (1) a VERIFIED-good outcome
 * (hal_decision = 'clean', not abstain/missing/vetoed — a HAL verdict grounded it, not mere completion); (2)
 * independence is ESTABLISHED (not same-owner, not unknown — no Sybil); (3) an idempotency key is present (not
 * replayable). Otherwise the award is DEMOTED to shadow (recorded as evidence, is_shadow = true) — never refused,
 * so no data is lost; it simply does not move the canonical, money-bearing score until it is properly grounded.
 *
 * PURE + INERT. This module only DECIDES; it writes nothing and touches no writer. The enforcement wiring consults
 * it behind the SERVICE_AWARD_FENCE flag (default OFF ⇒ behaviour byte-identical to today). Flipping the flag is a
 * MAJOR/owner action, ratified after the shadow measurement shows how many awards would demote (r23).
 */

export interface ServiceAwardContext {
  /** the HAL verdict attached to the award, if any. 'clean' is the only VERIFIED-good outcome. */
  hal_decision: 'vetoed' | 'flagged' | 'clean' | 'abstain' | null;
  /** from the settlement gate: 'independent' is the only state that proves it is not same-controller. */
  independence: 'independent' | 'same_owner' | 'unknown';
  /** replay protection — a canonical award without one can be re-applied. */
  idempotency_key: string | null;
  /** if the writer already marks this shadow, the fence leaves it shadow (nothing to demote). */
  already_shadow?: boolean;
}

export interface FenceDecision {
  /** true ⇒ the award may move canonical score. false ⇒ DEMOTE to shadow (record as evidence, is_shadow = true). */
  canonical: boolean;
  /** why it may not be canonical (empty when canonical). */
  reasons: string[];
}

/**
 * Decide whether a SERVICE_* award is eligible to move canonical RepID. Pure, total, never throws. A demote
 * (canonical:false) preserves the event as shadow evidence — it is never a refusal.
 */
export function fenceServiceAward(ctx: ServiceAwardContext): FenceDecision {
  if (ctx.already_shadow) return { canonical: false, reasons: ['already_shadow'] };
  const reasons: string[] = [];
  if (ctx.hal_decision !== 'clean') reasons.push(`unverified_outcome:${ctx.hal_decision ?? 'none'}`);
  if (ctx.independence !== 'independent') reasons.push(`independence_not_established:${ctx.independence}`);
  if (!ctx.idempotency_key) reasons.push('no_idempotency_key');
  return { canonical: reasons.length === 0, reasons };
}

/** The enforcement gate. Default OFF ⇒ the wiring leaves every award exactly as today (byte-identical). */
export const serviceAwardFenceEnabled = (): boolean => process.env['SERVICE_AWARD_FENCE'] === '1';
