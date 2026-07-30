// ANFIS escalation-only gate — the first live (non-shadow) ANFIS authority.
//
// WHY THIS SHAPE (2026-07-30, Claude+Grok D-054 round 2):
//   Flipping ANFIS fully live today would hand routing to a policy that has
//   NEVER BEEN FITTED. Verified live: `anfis_routing_logs` holds 256 rows all
//   time / 73 in 30d / 34 in 7d (~5 routing decisions per day across ALL
//   providers), while `ANFIS_RETUNE_ENABLED` defaults OFF and retune requires
//   ANFIS_RETUNE_MIN_SAMPLES = 20 samples PER PROVIDER PER 24h window. At
//   current throughput that floor is mathematically unreachable, so the
//   "learned" weights are priors. A miscalibrated router does not throw — it
//   silently sends work to the wrong model, which is the same failure class as
//   a swallowed HTTP 400 rendered as "RepID delta 0.00".
//
//   So ANFIS goes live in ONE DIRECTION. It may escalate (more capable model,
//   more verification) freely, because being too careful is a cost you can
//   measure. It may NOT descend below the stakes floor, because being too
//   careless is a silent quality regression you cannot.
//
//   This is the routing-layer twin of amendment A2 on the user preference
//   vector (Grok's Q7): the global SBFA bars are floors that a learned policy
//   may raise but never pierce. Same asymmetry, one layer down.
//
// WHAT THIS IS NOT: a claim that ANFIS is trained, accurate, or saving money.
// It is a bounded grant of authority whose worst case is "spent more than
// necessary" — an overspend that shows up in the cost dashboard rather than a
// quality loss that shows up nowhere.
//
// MODES (`ANFIS_ROUTING_MODE`):
//   shadow        — DEFAULT. Recommendation recorded, never applied (today's behavior).
//   escalate_only — ANFIS may raise the tier/verification, never lower it.
//   live          — reserved; NOT implemented on purpose. Flipping it requires
//                   a fitted policy, i.e. retune reaching its sample floor.
//                   Requesting `live` yields escalate_only + a loud warning,
//                   because silently honouring it would be the exact
//                   silent-degradation failure this module exists to prevent.

export type AnfisRoutingMode = 'shadow' | 'escalate_only' | 'live';

/** Capability ladder, ascending. Escalation = moving RIGHT. */
export const TIER_RANK: Record<string, number> = {
  slm: 0,
  '0a': 1,
  '0': 1,
  '1': 2,
};

export function anfisRoutingMode(): AnfisRoutingMode {
  const raw = (process.env.ANFIS_ROUTING_MODE || 'shadow').trim().toLowerCase();
  if (raw === 'escalate_only') return 'escalate_only';
  if (raw === 'live') {
    console.warn(
      '[anfis-escalation-gate] ANFIS_ROUTING_MODE=live requested but full authority is NOT implemented ' +
        '(the policy is unfitted: retune is off and cannot reach its per-provider sample floor at current ' +
        'throughput). Falling back to escalate_only.'
    );
    return 'escalate_only';
  }
  return 'shadow';
}

export function tierRank(tier: string | null | undefined): number {
  if (!tier) return TIER_RANK['0a'] as number;
  const r = TIER_RANK[String(tier).toLowerCase()];
  return typeof r === 'number' ? r : (TIER_RANK['0a'] as number);
}

export interface EscalationDecision {
  /** The tier that should actually be used. */
  tier: string;
  /** The provider that should actually be used. */
  provider: string;
  /** True when ANFIS's recommendation was adopted (an escalation). */
  escalated: boolean;
  /** True when ANFIS wanted to go DOWN and was refused. */
  deescalation_blocked: boolean;
  mode: AnfisRoutingMode;
  reason: string;
}

/**
 * Apply ANFIS's recommendation under escalation-only authority.
 *
 * Rules, in order:
 *  1. shadow mode          → always keep the static decision (record only).
 *  2. ANFIS wants a LOWER tier than the static router → REFUSED (this is the
 *     whole point; a de-escalation is the silent-failure direction).
 *  3. ANFIS wants a lower tier than the stakes floor  → REFUSED. The floor is
 *     inviolable even if the static router happens to sit below it.
 *  4. Otherwise (equal or higher tier) → adopt ANFIS's provider/tier.
 *
 * `stakesFloorTier` is supplied by the caller from the SBFA stakes level, so
 * this module stays pure and holds no dependency on consensus internals.
 */
export function applyEscalationOnly(input: {
  staticProvider: string;
  staticTier: string;
  anfisProvider: string;
  anfisTier: string;
  /** Minimum tier permitted at this stakes level (e.g. 'high' ⇒ never an SLM). */
  stakesFloorTier?: string | null;
  mode?: AnfisRoutingMode;
}): EscalationDecision {
  const mode = input.mode ?? anfisRoutingMode();
  const keep = (reason: string, deescalation_blocked = false): EscalationDecision => ({
    tier: input.staticTier,
    provider: input.staticProvider,
    escalated: false,
    deescalation_blocked,
    mode,
    reason,
  });

  if (mode === 'shadow') {
    return keep('shadow mode — ANFIS recommendation recorded, not applied');
  }

  const staticRank = tierRank(input.staticTier);
  const anfisRank = tierRank(input.anfisTier);

  if (anfisRank < staticRank) {
    return keep(
      `de-escalation refused: ANFIS recommended ${input.anfisTier} below the static ${input.staticTier} ` +
        `(escalation-only authority; the policy is unfitted)`,
      true
    );
  }

  const floorRank = input.stakesFloorTier ? tierRank(input.stakesFloorTier) : null;
  if (floorRank !== null && anfisRank < floorRank) {
    return keep(
      `stakes floor enforced: ANFIS recommended ${input.anfisTier} below the ${input.stakesFloorTier} floor`,
      true
    );
  }

  if (anfisRank === staticRank && input.anfisProvider === input.staticProvider) {
    return keep('ANFIS agreed with the static router');
  }

  if (anfisRank === staticRank) {
    // Same capability tier, different provider: a lateral move. Permitted —
    // it cannot reduce capability, and lateral diversity is what SBFA wants.
    return {
      tier: input.anfisTier,
      provider: input.anfisProvider,
      escalated: false,
      deescalation_blocked: false,
      mode,
      reason: `lateral move within tier ${input.anfisTier} (${input.staticProvider} → ${input.anfisProvider})`,
    };
  }

  return {
    tier: input.anfisTier,
    provider: input.anfisProvider,
    escalated: true,
    deescalation_blocked: false,
    mode,
    reason: `escalated ${input.staticTier} → ${input.anfisTier} (${input.staticProvider} → ${input.anfisProvider})`,
  };
}
