import { db } from '../db';
import { applyValidationEvent, deriveHalDecision } from '../scoring/pipeline';
import { evaluate } from '../hal/lib/evaluate';
import { hasTruthySimFlag } from '../utils/truthy';
import type { HALProviderConfig } from '../hal/lib/types';
import { factCheck, buildFactCheckProviders, factCheckOptsFromEnv } from '../hal/fact-check';
import { maybeWriteOnChainReputation } from './onchain-reputation-trigger';

/**
 * Phase 2.7.4 — Canonical RepID delta restoration (2026-05-16)
 *
 * Restored to canonical spec per May 15 handoff doc Architecture Decision #6
 * and Grok cross-validation (2026-05-16). Prior shipped values (-8 claimer slash,
 * +4 validator reward) were unauthorized drift approximately 31× smaller than
 * spec. This file now reflects the spec-aligned delta matrix tied to
 * Provenance Framework tiers, providing clean reduction-to-practice evidence
 * for P-003 (Pythagorean Comma BFT veto reduction-to-practice claims).
 *
 * Tier resolution implements Grok Option (b) — integer tier to Provenance
 * Framework tier via constant lookup table. Database schema unchanged.
 *
 * Modification of these constants requires:
 *   1. Update of HYPERDAG_ROADMAP_TO_A2A_MVP_v1.md Architecture Decision #6
 *   2. Strategy Claude approval
 *   3. Grok cross-validation for audit surface impact
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
        judgeVerdict,
        answer_text: taskData.result || '',
        prompt_text: taskData.description || taskData.title || '',
        task_domain: taskData.task_type || 'finance',
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
        consensus_reached: workerVerdict !== 'escalated',
        answer_text: taskData.result || '',
        prompt_text: taskData.description || taskData.title || '',
        task_domain: taskData.task_type || 'finance',
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

// === Simulation gate (shared across all four contract touchpoints) ===
//
// G1 extension (2026-07-29): the T1 fulfilled path has gated RepID deltas on
// simulated contracts since the F-series patch, but T2 (/satisfy), T3
// (/outcome), and dispute resolution applied deltas unconditionally — a
// simulated contract could still move real RepID through those paths
// (2 of 10 simulated demo contracts did, −100 provider, per
// 2026-05-27 CC2_MARKETPLACE_DEMO). All four paths now share this check:
// sim flags on the contract's metadata/payload (F-series normalized) plus the
// linked x402 settlement's is_simulated column.

/**
 * Sim check for an already-fetched service_contracts row. The settlement
 * lookup fails OPEN (log + continue), matching the original T1 behavior — a
 * transient DB error must not silently zero a legitimate delta.
 */
export async function contractRowIsSimulated(
  row: { metadata?: any; payload?: any; x402_payment_id?: string | null }
): Promise<boolean> {
  if (hasTruthySimFlag(row.metadata ?? {}) || hasTruthySimFlag(row.payload ?? {})) {
    return true;
  }
  if (row.x402_payment_id) {
    try {
      const { data: settlement } = await db
        .from('x402_settlements')
        .select('is_simulated')
        .eq('id', row.x402_payment_id)
        .maybeSingle();

      if (settlement?.is_simulated) {
        return true;
      }
    } catch (e: any) {
      console.error(`[contractRowIsSimulated] failed to fetch settlement details:`, e.message ?? String(e));
    }
  }
  return false;
}

/**
 * By-id variant for callers that don't hold the full row (T2/T3/dispute).
 * Fetch failures fail OPEN (same rationale as above).
 */
export async function isContractSimulated(contractId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('service_contracts')
      .select('metadata, payload, x402_payment_id')
      .eq('id', contractId)
      .maybeSingle();

    if (error || !data) {
      if (error) {
        console.error(`[isContractSimulated] failed to fetch contract ${contractId}:`, error.message ?? error);
      }
      return false;
    }
    return contractRowIsSimulated(data);
  } catch (e: any) {
    console.error(`[isContractSimulated] unexpected error for contract ${contractId}:`, e.message ?? String(e));
    return false;
  }
}

// Free-tier cross-LLM providers for HAL strictness:2 (cross-LLM consensus /
// Comma-BFT). Uses the fixed free-LLM router's providers (groq + cerebras) —
// never paid. Only providers with a key set are included; <2 degrades to the
// extractor signal. NOTE: comma_gap (the Pythagorean-Comma BFT veto) is null
// with <3 providers — a 3rd free provider (e.g. fireworks) would enable the
// full 3-provider Comma-BFT; tracked as a follow-up.
// Retained (exported) for the canonical comma-BFT lib path; strictness:2 now uses
// the fact-check evaluator (src/hal/fact-check.ts) per 2026-05-23 calibration.
export function buildFreeHalProviders(): HALProviderConfig[] {
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
  // Fetch full contract row to get x402_payment_id, metadata, payload, and result
  let fullContract: any = null;
  try {
    const { data, error: fetchErr } = await db
      .from('service_contracts')
      .select('*, agent_services(service_type)')
      .eq('id', contract.id)
      .maybeSingle();

    if (fetchErr) {
      console.error(
        `[applyServiceFulfilledDeltas] failed to fetch contract details:`,
        fetchErr.message ?? fetchErr
      );
    } else {
      fullContract = data;
    }
  } catch (e: any) {
    console.error(`[applyServiceFulfilledDeltas] unexpected error in fetch:`, e.message ?? String(e));
  }

  if (!fullContract) {
    console.warn(`[applyServiceFulfilledDeltas] No contract found for ${contract.id}, skipping deltas.`);
    return;
  }

  const payload: any = fullContract.payload ?? {};
  const meta: any = fullContract.metadata ?? {};

  // F-series patch (2026-05-22): normalize is_simulated across case/type
  // ("True"/"TRUE"/1/"1"/"yes") and nested/mislocated flags via
  // hasTruthySimFlag (src/utils/truthy.ts). Extracted to the shared
  // contractRowIsSimulated helper (2026-07-29) so T2/T3/dispute use the
  // identical gate.
  const isSimulated = await contractRowIsSimulated(fullContract);

  // G1: gate RepID delta on !isSimulated. If simulated, delta applied is 0.
  const providerDelta = isSimulated ? 0 : SERVICE_FULFILLED_DELTAS.provider;
  const buyerDelta = isSimulated ? 0 : SERVICE_FULFILLED_DELTAS.buyer;

  // HAL enrichment (2026-05-22): evaluate the deliverable text and pass a real
  // HAL verdict into the SERVICE_FULFILLED score-event rows below. NON-FATAL —
  // any failure (eval error, missing payload) falls back to undefined, so
  // applyValidationEvent uses its 0.5/clean default and fulfillment still
  // completes. Simulated/empty deliverables are skipped to save eval cost.
  // This block does NOT touch the bridge insert that follows.
  const halEnrichmentEnabled = process.env.HAL_ENRICHMENT_ENABLED === 'true';
  let halOverride: { hal_score: number; hal_decision: 'vetoed' | 'flagged' | 'clean' | 'abstain'; hal_signals?: any } | undefined;

  let deliverable = '';
  let promptText = '';

  try {
    deliverable = typeof payload.content === 'string' ? payload.content : '';
    promptText =
      (typeof payload.title === 'string' && payload.title) ||
      (typeof payload.criteria === 'string' ? payload.criteria : '') || '';

    if (halEnrichmentEnabled && !isSimulated && deliverable.trim().length > 0) {
      // Phase 4 (2026-05-23): HAL_STRICTNESS=1 = extractor-only (synchronous, no
      // LLM). HAL_STRICTNESS=2 = question-shaped cross-LLM FACT-CHECK — the
      // calibrated truth signal (discrimination gap +0.617 vs the extractor's
      // -0.020 on the 20-item corpus; caught_false 9/10, over-veto-true 0/7).
      // strictness:2 falls back to the extractor when no provider responds;
      // the outer catch falls to the 0.5/clean default.
      const halStrictness: 1 | 2 = process.env.HAL_STRICTNESS === '2' ? 2 : 1;
      const domain = typeof payload.task_type === 'string' ? payload.task_type : 'general';
      const runExtractor = async (): Promise<{ hal_score: number; hal_decision: 'vetoed' | 'flagged' | 'clean' | 'abstain'; hal_signals: any }> => {
        const r = await evaluate(deliverable, deliverable, { domain, certainty: 0.8, strictness: 1, prompt: promptText });
        return {
          hal_score: r.hal_score,
          hal_decision: deriveHalDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null),
          hal_signals: { mode: 'extractor', ...(r.signals as any) },
        };
      };
      if (halStrictness === 2) {
        const fc = await factCheck(deliverable, buildFactCheckProviders(), factCheckOptsFromEnv());
        if (fc.providers_used > 0) {
          halOverride = {
            hal_score: fc.hal_score,
            hal_decision: fc.decision,
            hal_signals: {
              mode: 'fact-check',
              providers_used: fc.providers_used,
              agreement: fc.agreement,
              degraded: fc.degraded,
              latency_ms: fc.latency_ms,
              verdicts: fc.verdicts,
              // V3 FIX 2026-07-05 — carry unmapped (regex-guessed) families into score-event metadata
              // so an unregistered provider model is auditable at the delta level, not just in logs.
              ...(fc.families_unmapped?.length ? { families_unmapped: fc.families_unmapped } : {}),
            },
          };
        } else {
          // No cross-LLM truth signal available → extractor fallback.
          halOverride = await runExtractor();
          (halOverride.hal_signals as any).mode = 'extractor-fallback';
        }
      } else {
        halOverride = await runExtractor();
      }
    }
  } catch (halErr: any) {
    console.error(
      `[hal-enrichment] eval failed for contract ${contract.id}; falling back to default 0.5/clean:`,
      halErr?.message ?? String(halErr),
    );
    halOverride = undefined;
  }

  // The two halves of one transaction. Each side now records the other, so the relationship
  // survives in the ledger instead of having to be re-derived from contract_id afterwards —
  // which only ever worked for the 0.8% of events that set it.
  await applyValidationEvent(
    contract.provider_agent_id,
    'SERVICE_FULFILLED',
    providerDelta,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'provider',
      counterparty_agent_id: contract.buyer_agent_id,
      answer_text: deliverable,
      prompt_text: promptText,
      task_domain: typeof payload.task_type === 'string' ? payload.task_type : 'general',
    },
    halOverride
  );
  await applyValidationEvent(
    contract.buyer_agent_id,
    'SERVICE_FULFILLED',
    buyerDelta,
    {
      contract_id: contract.id,
      service_id: contract.service_id,
      role: 'buyer',
      counterparty_agent_id: contract.provider_agent_id,
      answer_text: deliverable,
      prompt_text: promptText,
      task_domain: typeof payload.task_type === 'string' ? payload.task_type : 'general',
    },
    halOverride
  );

  try {
    if (fullContract.x402_payment_id) {
      const agentService = fullContract.agent_services;
      const taskType = meta.task_type || payload.task_type || agentService?.service_type || null;

      if (taskType !== null) {
        const verdict = fullContract.result?.verdict || null;

        const { data: insertedEvent, error: insertErr } = await db.from('repid_events').insert({
          subject_id: contract.provider_agent_id,
          subject_type: 'agent',
          event_type: 'service_fulfilled_settled',
          reputation_delta: providerDelta,
          event_data: {
            is_simulated: isSimulated,
            tx_hash: null,
            contract_id: contract.id,
            metadata: {
              contract_id: contract.id,
              x402_payment_id: fullContract.x402_payment_id,
              task_type: taskType,
              verdict: verdict,
            },
          },
        }).select('id').maybeSingle();

        if (insertErr) {
          console.error(
            `[applyServiceFulfilledDeltas] repid_events bridge insert FAILED:`,
            insertErr.message ?? insertErr,
            (insertErr as any).stack ?? new Error().stack
          );
        } else {
          console.log(`[applyServiceFulfilledDeltas] repid_events bridge insert SUCCEEDED for contract ${contract.id}`);

          // Buy-loop last mile (2026-07-06): best-effort INLINE ERC-8004 on-chain
          // reputation write. Gated (real settlement + token + floor), idempotent,
          // and NON-FATAL — any failure leaves this repid_events row unprocessed
          // for FeedbackLoopWorker to drain. Ships OFF behind
          // ONCHAIN_REPUTATION_TRIGGER_ENABLED. Never throws into the delta path.
          try {
            const outcome = await maybeWriteOnChainReputation({
              contractId: contract.id,
              providerAgentId: contract.provider_agent_id,
              isSimulated,
              repidEventId: insertedEvent?.id ?? null,
            });
            console.log(
              `[applyServiceFulfilledDeltas] on-chain reputation trigger outcome for contract ${contract.id}:`,
              JSON.stringify(outcome),
            );
          } catch (triggerErr: any) {
            // Defense-in-depth: maybeWriteOnChainReputation already swallows,
            // but never let the on-chain path break fulfillment.
            console.error(
              `[applyServiceFulfilledDeltas] on-chain reputation trigger threw (non-fatal):`,
              triggerErr?.message ?? String(triggerErr),
            );
          }
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
  // G1 (T2, 2026-07-29): same simulation gate as the fulfilled path — a
  // simulated contract's /satisfy writes 0-delta events (audit trail kept,
  // no RepID movement), mirroring T1.
  const isSimulated = await isContractSimulated(contract.id);
  const providerDelta = isSimulated ? 0 : Math.round(SERVICE_SATISFIED_DELTA_BASE.provider * satisfactionScore);
  const buyerDelta = isSimulated ? 0 : Math.round(SERVICE_SATISFIED_DELTA_BASE.buyer * satisfactionScore);

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


// === T3 — Delayed outcome signal ("held up in use?") ===================
//
// The THIRD and deepest RepID touchpoint for an A2A transaction, weight rising
// across the three:
//   T1 SERVICE_FULFILLED (settled, immediate, small)   provider +10 / buyer +5
//   T2 SERVICE_SATISFIED (to-spec, mins–hrs)           provider +30×score / buyer +15
//   T3 SERVICE_OUTCOME   (held-up-in-use, 24h–72h)  ← LARGEST weight, hardest to game
//
// 3-state rating → provider delta:
//   good = full positive · ok = ~0 (small/none) · bad = negative (+ dispute flag)
// The provider delta is scaled by the rater's own reputation (rater-weight): a
// higher-rep rater moves the provider more. The multiplier is clamped to a sane
// band so a whale can't nuke and a fresh account still counts a little.
//
// ── TUNING BLOCK (change these + log an audit line; Grok cross-validate for
//    audit-surface impact per the file header rules) ─────────────────────
const SERVICE_OUTCOME_BASE = {
  good: 60,   // full positive — largest of the three touchpoints' base magnitude
  ok:   0,    // honest middle — no move by default (small nudge possible via _OK_NUDGE)
  bad: -80,   // negative — outweighs the earlier positive touchpoints combined
} as const;

// If you want 'ok' to carry a faint positive signal ("used it, was fine"), set a
// small non-zero here. Kept 0 by design so the middle stays truly neutral.
const SERVICE_OUTCOME_OK_NUDGE = 0;

// Rater-weight: multiplier = clamp(rater_repid / PIVOT, MIN, MAX).
// PIVOT is the ESTABLISHED-tier floor (1000) so a baseline agent rates at ~1.0×.
const RATER_WEIGHT = {
  pivot: 1000,   // rater_repid at which weight == 1.0
  min:   0.25,   // floor — a brand-new rater still counts a quarter
  max:   2.0,    // ceiling — a maxed rater counts at most double
} as const;

export type ServiceOutcomeRating = 'good' | 'ok' | 'bad';

/** clamp(raterRepid / pivot) → the sane-band rater influence multiplier. */
export function computeRaterWeight(raterRepid: number | null | undefined): number {
  const r = typeof raterRepid === 'number' && Number.isFinite(raterRepid) ? raterRepid : 0;
  const raw = r / RATER_WEIGHT.pivot;
  return Math.min(RATER_WEIGHT.max, Math.max(RATER_WEIGHT.min, raw));
}

export interface ServiceOutcomeResult {
  providerDelta: number;       // the rounded delta applied to the provider
  baseDelta: number;           // pre-weight base for `rating`
  raterWeight: number;         // the clamped multiplier used
  disputeEligible: boolean;    // true iff rating === 'bad' (MAY open a dispute; never auto)
  scoreEventApplied: boolean;  // whether a repid_score_events row was written (delta !== 0)
}

/**
 * Apply the T3 outcome delta to the PROVIDER only. Rater-weighted and
 * absence-neutral (only a real rating ever reaches here). Returns the applied
 * numbers so the caller can persist the parallel service_outcomes row.
 *
 * The buyer/rater is NOT scored for rating — rating is a duty, not a
 * reward-farming surface. bad → disputeEligible=true (flag only, no auto-dispute).
 */
export async function applyServiceOutcomeDeltas(
  contract: { id: string; provider_agent_id: string; buyer_agent_id: string; service_id?: string },
  rating: ServiceOutcomeRating,
  raterRepid: number | null | undefined,
): Promise<ServiceOutcomeResult> {
  // G1 (T3, 2026-07-29): same simulation gate as T1/T2 — a simulated
  // contract's outcome rating never moves the provider (delta forced to 0, so
  // no score event is written below). disputeEligible is left as-is: it is a
  // flag, not a score move, and dispute deltas are gated separately.
  const isSimulated = await isContractSimulated(contract.id);
  const baseDelta =
    rating === 'ok' ? SERVICE_OUTCOME_OK_NUDGE : SERVICE_OUTCOME_BASE[rating];
  const raterWeight = computeRaterWeight(raterRepid);
  const providerDelta = isSimulated ? 0 : Math.round(baseDelta * raterWeight);
  const disputeEligible = rating === 'bad';

  let scoreEventApplied = false;
  if (providerDelta !== 0) {
    await applyValidationEvent(
      contract.provider_agent_id,
      'SERVICE_OUTCOME',
      providerDelta,
      {
        contract_id: contract.id,
        service_id: contract.service_id,
        role: 'provider',
        outcome_rating: rating,
        rater_agent_id: contract.buyer_agent_id,
        rater_repid_at_rating: raterRepid ?? null,
        rater_weight: raterWeight,
        // Consensus-divergence hook: a later pass can set/read this to discount
        // a rating that diverges from the T1/T2 signals. Not computed in T3 v1.
        divergence_discounted: false,
      },
    );
    scoreEventApplied = true;
  }

  return { providerDelta, baseDelta, raterWeight, disputeEligible, scoreEventApplied };
}


export async function applyServiceDisputeResolution(
  contract: { id: string, provider_agent_id: string, buyer_agent_id: string },
  verdict: 'provider_at_fault' | 'buyer_at_fault' | 'no_fault'
): Promise<void> {
  // G1 (dispute, 2026-07-29): same simulation gate as T1/T2/T3. This is the
  // exact path the 2026-05-27 marketplace demo leaked through (−100 provider
  // on simulated contracts).
  const isSimulated = await isContractSimulated(contract.id);
  if (isSimulated) {
    console.log(`[applyServiceDisputeResolution] contract ${contract.id} is simulated — skipping dispute deltas (verdict: ${verdict})`);
    return;
  }

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
