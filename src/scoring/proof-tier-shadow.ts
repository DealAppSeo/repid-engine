/**
 * proof-tier-shadow.ts — Shadow-only wiring for the ANFIS proof-tier selection gate
 * (backlog item 11, reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * WHAT THIS IS
 * ------------
 * `selectProofTier` (../services/proof-tier-policy.ts) is a pure decision layer that maps
 * PolicyAxes to a required proof strength. It is built and tested with zero callers in
 * the scoring path (PR #225, merged 2026-08-03; `shadowCompareProofTier` is an internal
 * comparison helper, not a scoring-path caller).
 *
 * This module wires it into `scoring/pipeline.ts` in the only honest way for now:
 * a SHADOW-ONLY logger that observes what tier would have been required for each scored
 * event, without changing any behaviour. It is a measurement step, not a gate.
 *
 * AXES MAPPING (HAL_SCORE_EVENT context)
 * ---------------------------------------
 * - stakes: derived from event type (CHALLENGE = 0.8, STAKE = 0.9, REFERRAL = 0.35,
 *   CODE_CONTRIBUTION = 0.6, default = 0.2) + VETERAN/AUTONOMOUS tier bonus (+0.15).
 * - costPressure: 0.3 (pipeline is async; latency is not the constraint)
 * - privacy: 0.5 (PII not typically present in scoring context)
 * - latencyUrgency: 0.2 (async pipeline; not time-critical)
 * - reliabilityRequired: stakes proxy (same value — high-stakes needs reliable proof)
 *
 * GATING
 * ------
 * Completely inert unless `PROOF_TIER_SHADOW_ENABLED=true`. Fire-and-forget async —
 * a failure must never break scoring. Called inside `runScoreEvent` after the ZK proof
 * queue insert, before the return, using `void`.
 *
 * SHADOW-FIRST INVARIANT
 * ----------------------
 * This module NEVER blocks or alters a score. It logs what tier would have been
 * selected. Switching from shadow to enforce requires a deliberate wiring change, not
 * an env flip.
 */

import { selectProofTier, type PolicyAxes } from '../services/proof-tier-policy';

const STAKES_BY_EVENT: Record<string, number> = {
  CHALLENGE: 0.8,
  STAKE: 0.9,
  REFERRAL: 0.35,
  CODE_CONTRIBUTION: 0.6,
  PEACEMAKER: 0.5,
  PREDICTION_RESOLVE: 0.55,
};

const HIGH_TIER_BONUS = 0.15;
const HIGH_TIERS = new Set(['VETERAN', 'AUTONOMOUS']);

function buildAxes(eventType: string, agentTier: string): PolicyAxes {
  const baseStakes = STAKES_BY_EVENT[eventType] ?? 0.2;
  const stakes = HIGH_TIERS.has(agentTier) ? Math.min(baseStakes + HIGH_TIER_BONUS, 1.0) : baseStakes;
  return {
    stakes,
    costPressure: 0.3,
    privacy: 0.5,
    latencyUrgency: 0.2,
    reliabilityRequired: stakes,
  };
}

/**
 * Observe which proof tier would have been required for this scoring event, and log it.
 * Returns null when the gate is off. Never throws.
 */
export async function shadowProofTier(eventType: string, agentTier: string): Promise<void> {
  if (process.env['PROOF_TIER_SHADOW_ENABLED'] !== 'true') return;

  try {
    const axes = buildAxes(eventType, agentTier);
    const decision = selectProofTier(axes);

    console.log(
      '[PROOF-TIER-SHADOW]',
      JSON.stringify({
        eventType,
        agentTier,
        tier: decision.tier,
        tierIndex: decision.tierIndex,
        zkRequired: decision.zkRequired,
        confidence: decision.confidence,
        drivers: decision.drivers,
        rationale: decision.rationale,
        axes,
      }),
    );
  } catch (e: unknown) {
    console.warn('[PROOF-TIER-SHADOW] error (inert):', (e as Error)?.message ?? e);
  }
}
