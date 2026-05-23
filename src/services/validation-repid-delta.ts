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
    } else {
      console.error(`[applyValidationDeltas] CRITICAL: Claimer agent not found for task ${taskData.id}: ${taskData.claimed_by}`);
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
    } else {
      console.error(`[applyValidationDeltas] CRITICAL: Validator agent not found for task ${taskData.id}: ${validatorName}`);
    }
  }
}

// === Service Contract Deltas (Phase 2.9 — locked in roadmap Architecture Decision #8) ===
//
// TWO events per contract for v1/v2 economic clarity:
//   Event 1 (SERVICE_FULFILLED): clean transaction occurred, regardless of quality
//   Event 2 (SERVICE_SATISFIED): buyer assessed quality and was satisfied
//
// This rewards both throughput (do work) and quality (do work well).

const SERVICE_FULFILLED_DELTAS = {
  provider: 10,
  buyer: 5,
} as const;

const SERVICE_SATISFIED_DELTA_BASE = {
  provider: 30,  // multiplied by satisfaction_score
  buyer: 15,
} as const;

const SERVICE_DISPUTE_DELTAS = {
  provider_at_fault: { provider: -100, buyer: 20 },   // BFT verdict caught provider failure
  buyer_at_fault:    { provider: 20, buyer: -50 },    // BFT verdict caught false dispute
  no_fault:          { provider: 0, buyer: 0 },
} as const;

export async function applyServiceFulfilledDeltas(
  contract: { id: string, service_id: string, provider_agent_id: string, buyer_agent_id: string }
): Promise<void> {
  await applyValidationEvent(
    contract.provider_agent_id,
    'SERVICE_FULFILLED',
    SERVICE_FULFILLED_DELTAS.provider,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'provider',
    }
  );
  await applyValidationEvent(
    contract.buyer_agent_id,
    'SERVICE_FULFILLED',
    SERVICE_FULFILLED_DELTAS.buyer,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'buyer',
    }
  );

  try {
    // Fetch full contract row to get x402_payment_id, metadata, payload, and result
    const { data: fullContract, error: fetchErr } = await db
      .from('service_contracts')
      .select('*, agent_services(service_type)')
      .eq('id', contract.id)
      .maybeSingle();

    if (fetchErr) {
      console.error(
        `[applyServiceFulfilledDeltas] failed to fetch contract details:`,
        fetchErr.message ?? fetchErr,
        (fetchErr as any).stack ?? new Error().stack
      );
    } else if (fullContract && fullContract.x402_payment_id) {
      const agentService = (fullContract as any).agent_services;
      const taskType = fullContract.metadata?.task_type || fullContract.payload?.task_type || agentService?.service_type || null;

      if (taskType !== null) {
        let isSimulated = false;
        if (
          fullContract.metadata?.is_simulated === true ||
          fullContract.metadata?.is_simulated === 'true' ||
          fullContract.payload?.is_simulated === true ||
          fullContract.payload?.is_simulated === 'true'
        ) {
          isSimulated = true;
        }

        // Check if settlement is simulated
        const { data: settlement } = await db
          .from('x402_settlements')
          .select('is_simulated')
          .eq('id', fullContract.x402_payment_id)
          .maybeSingle();

        if (settlement?.is_simulated) {
          isSimulated = true;
        }

        const verdict = fullContract.result?.verdict || null;

        const { error: insertErr } = await db.from('repid_events').insert({
          subject_id: contract.provider_agent_id,
          subject_type: 'agent',
          event_type: 'service_fulfilled_settled',
          reputation_delta: SERVICE_FULFILLED_DELTAS.provider,
          event_data: {
            is_simulated: isSimulated,
            tx_hash: null,
            metadata: {
              contract_id: contract.id,
              x402_payment_id: fullContract.x402_payment_id,
              task_type: taskType,
              verdict: verdict,
            },
          },
        });

        if (insertErr) {
          console.error(
            `[applyServiceFulfilledDeltas] repid_events bridge insert FAILED:`,
            insertErr.message ?? insertErr,
            (insertErr as any).stack ?? new Error().stack
          );
        } else {
          console.log(`[applyServiceFulfilledDeltas] repid_events bridge insert SUCCEEDED for contract ${contract.id}`);
        }
      }
    }
  } catch (e: any) {
    console.error(
      `[applyServiceFulfilledDeltas] unexpected error in bridge insertion:`,
      e.message ?? String(e),
      e.stack ?? new Error().stack
    );
  }
}

export async function applyServiceSatisfiedDeltas(
  contract: { id: string, provider_agent_id: string, buyer_agent_id: string },
  satisfactionScore: number
): Promise<void> {
  const providerDelta = Math.round(SERVICE_SATISFIED_DELTA_BASE.provider * satisfactionScore);
  const buyerDelta = Math.round(SERVICE_SATISFIED_DELTA_BASE.buyer * satisfactionScore);

  await applyValidationEvent(
    contract.provider_agent_id,
    'SERVICE_SATISFIED',
    providerDelta,
    {
      contract_id: contract.id,
      satisfaction_score: satisfactionScore,
      role: 'provider',
    }
  );
  await applyValidationEvent(
    contract.buyer_agent_id,
    'SERVICE_SATISFIED',
    buyerDelta,
    {
      contract_id: contract.id,
      satisfaction_score: satisfactionScore,
      role: 'buyer',
    }
  );
}


export async function applyServiceDisputeResolution(
  contract: { id: string, provider_agent_id: string, buyer_agent_id: string },
  verdict: 'provider_at_fault' | 'buyer_at_fault' | 'no_fault'
): Promise<void> {
  const deltas = SERVICE_DISPUTE_DELTAS[verdict];
  
  if (deltas.provider !== 0) {
    await applyValidationEvent(
      contract.provider_agent_id,
      deltas.provider > 0 ? 'SERVICE_FULFILLED' : 'VALIDATION_FAILED',
      deltas.provider,
      {
        contract_id: contract.id,
        verdict,
        role: 'provider',
      }
    );
  }
  
  if (deltas.buyer !== 0) {
    await applyValidationEvent(
      contract.buyer_agent_id,
      deltas.buyer > 0 ? 'SERVICE_FULFILLED' : 'VALIDATION_FAILED',
      deltas.buyer,
      {
        contract_id: contract.id,
        verdict,
        role: 'buyer',
      }
    );
  }
}
