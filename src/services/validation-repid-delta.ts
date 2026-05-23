import { db } from '../db';
import { applyValidationEvent, deriveHalDecision } from '../scoring/pipeline';
import { evaluate } from '../hal/lib/evaluate';
import { hasTruthySimFlag } from '../utils/truthy';
import type { HALProviderConfig } from '../hal/lib/types';

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

// Free-tier cross-LLM providers for HAL strictness:2 (cross-LLM consensus /
// Comma-BFT). Uses the fixed free-LLM router's providers (groq + cerebras) —
// never paid. Only providers with a key set are included; <2 degrades to the
// extractor signal. NOTE: comma_gap (the Pythagorean-Comma BFT veto) is null
// with <3 providers — a 3rd free provider (e.g. fireworks) would enable the
// full 3-provider Comma-BFT; tracked as a follow-up.
function buildFreeHalProviders(): HALProviderConfig[] {
  const out: HALProviderConfig[] = [];
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey) {
    out.push({
      provider: 'groq',
      model: process.env.HAL_S2_GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: groqKey,
      callType: 'openai-compat',
    });
  }
  const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim();
  if (cerebrasKey) {
    out.push({
      provider: 'cerebras',
      model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'llama3.1-8b',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: cerebrasKey,
      callType: 'openai-compat',
    });
  }
  return out;
}

export async function applyServiceFulfilledDeltas(
  contract: { id: string, service_id: string, provider_agent_id: string, buyer_agent_id: string }
): Promise<void> {
  // HAL enrichment (2026-05-22): evaluate the deliverable text and pass a real
  // HAL verdict into the SERVICE_FULFILLED score-event rows below. NON-FATAL —
  // any failure (eval error, missing payload) falls back to undefined, so
  // applyValidationEvent uses its 0.5/clean default and fulfillment still
  // completes. Simulated/empty deliverables are skipped to save eval cost.
  // This block does NOT touch the bridge insert that follows.
  // Phase 1 (2026-05-23): HAL enrichment ships behind HAL_ENRICHMENT_ENABLED
  // (default off → applyValidationEvent uses its 0.5/clean default = legacy
  // behavior, byte-identical to pre-HAL-enrichment main). Zero behavior change
  // at merge time; Sean flips the flag post-merge after smoke verification.
  const halEnrichmentEnabled = process.env.HAL_ENRICHMENT_ENABLED === 'true';
  let halOverride: { hal_score: number; hal_decision: 'vetoed' | 'flagged' | 'clean'; hal_signals?: any } | undefined;
  try {
    const { data: cRow } = await db
      .from('service_contracts')
      .select('payload, metadata')
      .eq('id', contract.id)
      .maybeSingle();
    const payload: any = (cRow as any)?.payload ?? {};
    const meta: any = (cRow as any)?.metadata ?? {};
    const deliverable: string = typeof payload.content === 'string' ? payload.content : '';
    const promptText: string =
      (typeof payload.title === 'string' && payload.title) ||
      (typeof payload.criteria === 'string' ? payload.criteria : '') || '';
    const isSimulated =
      meta.is_simulated === true || meta.is_simulated === 'true' ||
      payload.is_simulated === true || payload.is_simulated === 'true';
    if (halEnrichmentEnabled && !isSimulated && deliverable.trim().length > 0) {
      // Phase 2 (2026-05-23): HAL_STRICTNESS selects extractor-only (1, default,
      // synchronous, no LLM fan-out) vs cross-LLM consensus / Comma-BFT (2,
      // ~0.5-2s, fans out to free providers). On a strictness:2 error we fall
      // back to strictness:1; only a double failure falls to the 0.5/clean
      // default (outer catch). Clamp guards against bad env values.
      const halStrictness: 1 | 2 = process.env.HAL_STRICTNESS === '2' ? 2 : 1;
      const domain = typeof payload.task_type === 'string' ? payload.task_type : 'general';
      const runEval = (s: 1 | 2) =>
        evaluate(deliverable, deliverable, {
          domain,
          certainty: 0.8,
          strictness: s,
          prompt: promptText,
          // strictness:2 requires providers for cross-LLM consensus / Comma-BFT.
          ...(s === 2 ? { providers: buildFreeHalProviders() } : {}),
        });
      let halResult;
      if (halStrictness === 2) {
        try {
          halResult = await runEval(2);
        } catch (s2err: any) {
          console.error(
            `[hal-enrichment] strictness:2 failed for contract ${contract.id}; falling back to strictness:1:`,
            s2err?.message ?? String(s2err),
          );
          halResult = await runEval(1);
        }
      } else {
        halResult = await runEval(1);
      }
      const decision = deriveHalDecision(
        halResult.hal_score,
        halResult.vetoed,
        (halResult.signals as any)?.comma_severity ?? null,
      );
      halOverride = {
        hal_score: halResult.hal_score,
        hal_decision: decision,
        hal_signals: halResult.signals,
      };
    }
  } catch (halErr: any) {
    console.error(
      `[hal-enrichment] eval failed for contract ${contract.id}; falling back to default 0.5/clean:`,
      halErr?.message ?? String(halErr),
    );
    halOverride = undefined;
  }

  await applyValidationEvent(
    contract.provider_agent_id,
    'SERVICE_FULFILLED',
    SERVICE_FULFILLED_DELTAS.provider,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'provider',
    },
    halOverride
  );
  await applyValidationEvent(
    contract.buyer_agent_id,
    'SERVICE_FULFILLED',
    SERVICE_FULFILLED_DELTAS.buyer,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'buyer',
    },
    halOverride
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
        // F-series patch (2026-05-22): normalize is_simulated across case/type
        // ("True"/"TRUE"/1/"1"/"yes") and nested/mislocated flags via
        // hasTruthySimFlag (src/utils/truthy.ts). Replaces the prior
        // case-sensitive `=== true || === 'true'` check. The x402_settlements
        // check below is unchanged (settlement-level safety net).
        let isSimulated =
          hasTruthySimFlag(fullContract.metadata) ||
          hasTruthySimFlag(fullContract.payload);

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
