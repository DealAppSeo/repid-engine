import { db } from '../db';
import { applyValidationEvent } from '../scoring/pipeline';

/**
 * Phase 2.7.4 — Canonical RepID delta restoration (2026-05-16)
 *
 * Restored to canonical spec per May 15 handoff doc Architecture Decision #6
 * and Grok cross-validation (2026-05-16). Prior shipped values (-8 claimer slash,
 * +4 validator reward) were unauthorized drift approximately 31× smaller than
 * spec. This file now reflects the patent-aligned delta matrix tied to
 * Provenance Framework tiers, providing clean reduction-to-practice evidence
 * for P-003 (Pythagorean Comma BFT veto reduction-to-practice claims).
 *
 * Tier resolution implements Grok Option (b) — integer tier to Provenance
 * Framework tier via constant lookup table. Database schema unchanged.
 *
 * Modification of these constants requires:
 *   1. Update of HYPERDAG_ROADMAP_TO_A2A_MVP_v1.md Architecture Decision #6
 *   2. Strategy Claude approval
 *   3. Grok cross-validation for patent surface impact
 *   4. New audit-log entry below this block
 *
 * Audit log:
 *   - 2026-05-16: Phase 2.7.4 restored canonical values per May 15 handoff + Grok confirmation
 */

// === Tier Lookup (Grok Option b) ===
type ProvenanceTier =
  | 'T0_BENCHMARK'
  | 'T1_INTERNAL_FAKE'
  | 'T2a_INTERNAL_REAL_ORGANIC'
  | 'T2b_INTERNAL_REAL_ADVERSARIAL'
  | 'T3a_EXTERNAL_TEST_PRIVATE'
  | 'T3b_EXTERNAL_TEST_PUBLIC'
  | 'T4_EXTERNAL_REAL_PRODUCTION';

type TierBand = 'T2a' | 'T3plus';

const TIER_INT_TO_PROVENANCE: Record<number, ProvenanceTier> = {
  0: 'T0_BENCHMARK',
  1: 'T1_INTERNAL_FAKE',
  2: 'T2a_INTERNAL_REAL_ORGANIC',
  3: 'T2b_INTERNAL_REAL_ADVERSARIAL',
  4: 'T3a_EXTERNAL_TEST_PRIVATE',
  5: 'T3b_EXTERNAL_TEST_PUBLIC',
  6: 'T4_EXTERNAL_REAL_PRODUCTION',
};

const TIER_BAND_MAP: Record<ProvenanceTier, TierBand> = {
  T0_BENCHMARK: 'T2a',
  T1_INTERNAL_FAKE: 'T2a',
  T2a_INTERNAL_REAL_ORGANIC: 'T2a',
  T2b_INTERNAL_REAL_ADVERSARIAL: 'T2a',
  T3a_EXTERNAL_TEST_PRIVATE: 'T3plus',
  T3b_EXTERNAL_TEST_PUBLIC: 'T3plus',
  T4_EXTERNAL_REAL_PRODUCTION: 'T3plus',
};

export function tierToProvenance(numericTier: number | null | undefined): ProvenanceTier {
  if (numericTier == null) return 'T0_BENCHMARK';
  if (numericTier >= 7) return 'T4_EXTERNAL_REAL_PRODUCTION';
  return TIER_INT_TO_PROVENANCE[numericTier] ?? 'T0_BENCHMARK';
}

export function tierBand(numericTier: number | null | undefined): TierBand {
  return TIER_BAND_MAP[tierToProvenance(numericTier)];
}

// === Canonical RepID Delta Matrix (May 15 handoff doc Architecture Decision #6) ===
const CLAIMER_DELTAS = {
  verified:         { T2a:   80, T3plus:  200 },
  challenged:       { T2a: -250, T3plus: -500 },
  rework_required:  { T2a:    0, T3plus:    0 },
  no_action:        { T2a:    0, T3plus:    0 },
} as const;

const VALIDATOR_DELTAS = {
  agreed_no_correctness:    40,
  agreed_with_correctness:  120,
  caught_real_failure:      300,
  overturned: { T2a: -300, T3plus: -500 },
} as const;

export async function applyValidationDeltas(
  claimId: string, 
  taskData: any, 
  workerVerdict: 'verified' | 'challenged' | 'rework_required' | 'no_action' | string, 
  validators: string[], 
  judgeVerdict: string
) {
  const outcome = workerVerdict as keyof typeof CLAIMER_DELTAS;
  if (!(outcome in CLAIMER_DELTAS)) {
    return; // Fallback for unknown outcomes
  }

  const band = tierBand(taskData.tier);
  const claimerDelta = CLAIMER_DELTAS[outcome][band];
  
  let claimerEventType: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' = 'VALIDATION_FAILED';
  if (outcome === 'verified') claimerEventType = 'VALIDATION_PASSED';

  if (claimerDelta !== 0 && taskData.claimed_by) {
    const { data: claimerInfo } = await db.from('repid_agents').select('id').eq('agent_name', taskData.claimed_by).single();
    if (claimerInfo) {
      await applyValidationEvent(claimerInfo.id, claimerEventType, claimerDelta, {
        validation_queue_id: claimId,
        claim_id: claimId,
        task_id: taskData.id,
        outcome,
        tier_band: band,
        tier_provenance: tierToProvenance(taskData.tier),
        judgeVerdict
      });
    }
  }

  // Validator Deltas
  for (const validatorName of validators) {
    const { data: validatorInfo } = await db.from('repid_agents').select('id').eq('agent_name', validatorName).single();
    if (validatorInfo) {
      let valDelta = VALIDATOR_DELTAS.agreed_no_correctness;
      let valType: 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' = 'VALIDATOR_REWARD';
      
      if (workerVerdict === 'challenged' || workerVerdict === 'escalated') {
        valDelta = VALIDATOR_DELTAS.agreed_no_correctness; // Standard reward if consensus reached without correctness distinction
      }

      await applyValidationEvent(validatorInfo.id, valType, valDelta, {
        validation_queue_id: claimId,
        claim_id: claimId,
        task_id: taskData.id,
        outcome,
        tier_band: band,
        tier_provenance: tierToProvenance(taskData.tier),
        consensus_reached: workerVerdict !== 'escalated'
      });
    }
  }
}
