/**
 * HAL v2 — tiered consensus orchestrator.
 *
 * Entry point that ties classifier → Tier 1 → Tier 2 → (optional) Tier 3
 * together. Honours user RepID tier (free vs paid vs autonomous) when
 * deciding the max tier.
 *
 * Escalation rules:
 *  - AGREE_DIFFERENT at any tier  → HALLUCINATION_DETECTED, stop here.
 *  - AGREE (CORRECT) at any tier  → TRUTH_VERIFIED, stop here.
 *  - AGREE (UNCERTAIN) at any tier → escalate (uncertain consensus is not a
 *    verdict — it's a "we can't tell").
 *  - SPLIT / ALL_DIFFERENT       → escalate.
 *  - max_tier reached without verdict → UNRESOLVED with all tier results.
 *  - classifier reports OUT_OF_SCOPE (opinion/creative) → return immediately.
 */
import { TierResult } from './hal-tier1-slm';
import { tier1SlmConsensus } from './hal-tier1-slm';
import { tier2MiniConsensus } from './hal-tier2-mini';
import { tier3FrontierConsensus } from './hal-tier3-frontier';
import { classifyQuery, QueryClassification } from './hal-query-classifier';

export type FinalVerdict =
  | 'TRUTH_VERIFIED'
  | 'HALLUCINATION_DETECTED'
  | 'UNRESOLVED'
  | 'OUT_OF_SCOPE';

export interface ConsensusResult {
  final_verdict: FinalVerdict;
  consensus_answer?: string;
  tier_reached: 0 | 1 | 2 | 3;
  total_cost_usd: number;
  total_latency_ms: number;
  classification: QueryClassification;
  tier_results: TierResult[];
  audit_trail: {
    query: string;
    claim: string;
    started_at: string;
    finished_at: string;
    escalations: number;
    note?: string;
  };
}

export interface ConsensusOptions {
  starting_tier?: 0 | 1 | 2 | 3;
  max_tier?: 1 | 2 | 3;
  user_repid_tier?: 'CUSTODIED_DBT' | 'EARNING_AUTONOMY' | 'AUTONOMOUS';
  allow_tier3?: boolean;
  // Optional override for testing — inject classification instead of calling the classifier.
  injected_classification?: QueryClassification;
}

function maxTierForUser(
  userTier: ConsensusOptions['user_repid_tier'],
  override?: 1 | 2 | 3,
): 1 | 2 | 3 {
  if (override) return override;
  switch (userTier) {
    case 'AUTONOMOUS':       return 3;
    case 'EARNING_AUTONOMY': return 2;
    case 'CUSTODIED_DBT':
    default:                 return 2;
  }
}

export async function tieredConsensusCheck(
  query: string,
  claim: string,
  options: ConsensusOptions = {},
): Promise<ConsensusResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const classification = options.injected_classification
    ?? await classifyQuery(query, claim);

  const initialTier =
    options.starting_tier !== undefined
      ? options.starting_tier
      : classification.recommended_starting_tier;

  const maxTier = maxTierForUser(options.user_repid_tier, options.max_tier);

  // OUT_OF_SCOPE — opinion / creative / classifier said skip.
  if (initialTier === 0) {
    return {
      final_verdict: 'OUT_OF_SCOPE',
      tier_reached: 0,
      total_cost_usd: 0,
      total_latency_ms: Date.now() - start,
      classification,
      tier_results: [],
      audit_trail: {
        query, claim,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        escalations: 0,
        note: 'Subjective or creative query — no factual ground truth to verify.',
      },
    };
  }

  const tierResults: TierResult[] = [];
  let currentTier: 1 | 2 | 3 = Math.max(1, initialTier as number) as 1 | 2 | 3;
  let escalations = 0;

  while (currentTier <= maxTier) {
    const result =
      currentTier === 1 ? await tier1SlmConsensus(query, claim) :
      currentTier === 2 ? await tier2MiniConsensus(query, claim) :
                          await tier3FrontierConsensus(query, claim, {
                            allow_tier3: options.allow_tier3 === true,
                          });
    tierResults.push(result);

    // AGREE_DIFFERENT — strong hallucination signal at any tier.
    if (result.consensus === 'AGREE_DIFFERENT') {
      return finish(
        'HALLUCINATION_DETECTED',
        result.consensus_answer,
        currentTier,
        tierResults,
        classification,
        query, claim, startedAt, start, escalations,
      );
    }

    // AGREE on CORRECT — truth verified at this tier.
    if (result.consensus === 'AGREE' && result.consensus_vote === 'CORRECT') {
      return finish(
        'TRUTH_VERIFIED',
        undefined,
        currentTier,
        tierResults,
        classification,
        query, claim, startedAt, start, escalations,
      );
    }

    // AGREE on UNCERTAIN — escalate; this isn't a verdict.
    // SPLIT / ALL_DIFFERENT / TIMEOUT / NO_PROVIDERS — also escalate.
    if (currentTier < maxTier) {
      escalations += 1;
      currentTier = (currentTier + 1) as 1 | 2 | 3;
      continue;
    }

    // We're at max tier and still no verdict.
    break;
  }

  return finish(
    'UNRESOLVED',
    tierResults[tierResults.length - 1]?.consensus_answer,
    currentTier,
    tierResults,
    classification,
    query, claim, startedAt, start, escalations,
    'Reached max tier without consensus.',
  );
}

function finish(
  verdict: FinalVerdict,
  consensus_answer: string | undefined,
  tierReached: 0 | 1 | 2 | 3,
  tierResults: TierResult[],
  classification: QueryClassification,
  query: string,
  claim: string,
  startedAt: string,
  startMs: number,
  escalations: number,
  note?: string,
): ConsensusResult {
  const total_cost_usd = tierResults.reduce((a, r) => a + r.cost_estimate_usd, 0);
  return {
    final_verdict: verdict,
    consensus_answer,
    tier_reached: tierReached,
    total_cost_usd,
    total_latency_ms: Date.now() - startMs,
    classification,
    tier_results: tierResults,
    audit_trail: {
      query, claim,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      escalations,
      note,
    },
  };
}
