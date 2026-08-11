/**
 * selection-score.ts — "which agent should I trust with THIS job?"
 *
 * A directory says *these 427 can audit Solidity*. A2A says how to talk to them. x402 says how to
 * pay. ERC-8004 says they persist. **None of them answers which one to choose.** That question is
 * asked by machines, millions of times a day, and this module is our answer to it.
 *
 * PURE. No I/O, clock injected. Same discipline as write-lease.ts: this decides, something else
 * fetches. That is what makes the verdict reproducible by whoever consumes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MAKES THE NUMBER HONEST
 *
 * A dimension we cannot evidence is **omitted and named** — never quietly defaulted to a neutral
 * 1.0. A neutral default is a FABRICATED FACTOR: it moves the score, it is indistinguishable in
 * the output from a measured one, and it hides inside arithmetic that looks computed. It is the
 * same class of lie as seeding a marketplace with invented job counts, and worse, because a
 * reader can spot a fake row and cannot spot a fake multiplicand.
 *
 * So every result carries `dimensionsUsed`, `dimensionsUnavailable` and `coverage`. A 0.91 built
 * from two of six dimensions is NOT comparable to a 0.91 built from six, and the output says so
 * rather than leaving the consumer to assume. This is "a measurement without its ruler is not a
 * result" (LESSONS 8) applied to selection instead of to F1.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY WEIGHTED-MEAN-OVER-AVAILABLE, NOT A PRODUCT
 *
 * The intuitive form is a product of factors. It is wrong here for two reasons: a single missing
 * factor silently zeroes or (if defaulted) inflates the whole score, and products make it
 * impossible to say how much of the verdict was actually evidenced. A weighted mean over the
 * dimensions we HAVE, with the weight renormalised and the shortfall reported as `coverage`,
 * keeps the score interpretable and the ignorance visible.
 *
 * FAILURE IS THE EXCEPTION, AND IT IS ASYMMETRIC. A catastrophic failure is applied as a
 * MULTIPLICATIVE PENALTY outside the mean, because "no serious failures" is a constraint, not a
 * feature to be traded off. Volume must not wash out a slashing: an agent with 500 good jobs and
 * one fabricated deliverable is not interchangeable with one that has 499 good jobs.
 *
 * SHADOW-FIRST: computing and exposing a score is inert. Nothing here moves money, gates a
 * contract, or writes reputation. Making it load-bearing is a separate, measured decision.
 */

/** Every dimension this module knows about — including the ones it cannot yet compute. */
export type Dimension =
  | 'earned_reputation'
  | 'verified_experience'
  | 'satisfaction'
  | 'reliability'
  | 'settlement_history'
  | 'onchain_provenance';

/**
 * Dimensions the selection problem genuinely needs and that we CANNOT evidence today.
 *
 * Named here rather than omitted silently, so a consumer knows what the score is blind to.
 * Moving one of these into `Dimension` requires a real data source, not a heuristic.
 */
export const NOT_YET_COMPUTABLE = Object.freeze([
  'task_similarity',      // needs embeddings over job descriptions
  'validator_confidence', // needs an independent-validator track record
  'collusion_risk',       // needs counterparty-graph analysis
  'sybil_risk',           // needs the co-failure correlation score
  'contextual_trust',     // needs requester<->provider shared history
] as const);

/** Relative weights. They express what we believe matters; they are not measured. */
const WEIGHTS: Record<Dimension, number> = {
  earned_reputation: 0.30,
  verified_experience: 0.20,
  satisfaction: 0.20,
  reliability: 0.15,
  settlement_history: 0.10,
  onchain_provenance: 0.05,
};

/** RepID is clamped to [10, 10000] by the engine; normalise against that, not against the max seen. */
const REPID_MAX = 10_000;

/** Experience saturates: the 200th job says much less than the 5th. */
const EXPERIENCE_SATURATION = 50;

export interface CandidateEvidence {
  agentId: string;
  agentName: string;
  /** Always present — every registered agent has one. */
  currentRepid: number;
  /** Completed jobs for this service. 0 is a VALUE (no track record), not missing data. */
  totalFulfilled: number;
  /** Mean satisfaction. `null` when there are no completed jobs — genuinely UNAVAILABLE. */
  avgSatisfaction: number | null;
  /** Resolved disputes where this agent was the defendant and lost. Asymmetric penalty. */
  catastrophicFailures: number;
  /** Disputes raised against it, resolved or not. */
  disputesTotal: number;
  /** Successful x402 settlements. `null` if the settlement ledger was not queried. */
  settlementsSettled: number | null;
  /** ERC-8004 attestations written on-chain. `null` if chain data was not fetched. */
  onchainAttestations: number | null;
  /** Last verifiable activity. `null` if unknown — do NOT substitute "now". */
  lastActivityAt: string | null;
}

export interface DimensionScore {
  dimension: Dimension;
  /** 0..1 */
  value: number;
  weight: number;
  /** What this was derived from — so the consumer can re-derive it. */
  evidence: string;
}

export interface SelectionScore {
  agentId: string;
  agentName: string;
  /** 0..1 over the dimensions actually evidenced, after the failure penalty. */
  score: number;
  /**
   * Fraction of the implementable weight that was actually evidenced. A score at coverage 0.35
   * is a guess wearing a number; compare scores only at comparable coverage.
   */
  coverage: number;
  dimensionsUsed: DimensionScore[];
  /** Implementable dimensions we had no evidence for THIS candidate. */
  dimensionsUnavailable: Dimension[];
  /** Dimensions the model does not implement at all. Constant, but returned so it is never forgotten. */
  dimensionsNotImplemented: readonly string[];
  /** Multiplicative penalty applied outside the mean. 1 = clean. */
  failurePenalty: number;
  /** Human-readable reasons, in the order applied. */
  notes: string[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Score one candidate.
 *
 * `now` is injected so recency is testable and the verdict is reproducible from the same inputs.
 */
export function scoreCandidate(c: CandidateEvidence, now: number): SelectionScore {
  const used: DimensionScore[] = [];
  const unavailable: Dimension[] = [];
  const notes: string[] = [];

  // --- earned reputation: always available ------------------------------------------------
  used.push({
    dimension: 'earned_reputation',
    value: clamp01(c.currentRepid / REPID_MAX),
    weight: WEIGHTS.earned_reputation,
    evidence: `current_repid=${c.currentRepid}`,
  });

  // --- verified experience: 0 is EVIDENCE (no track record), not absence --------------------
  used.push({
    dimension: 'verified_experience',
    value: clamp01(c.totalFulfilled / EXPERIENCE_SATURATION),
    weight: WEIGHTS.verified_experience,
    evidence: `total_fulfilled=${c.totalFulfilled}`,
  });
  if (c.totalFulfilled === 0) {
    notes.push('no completed jobs — scored as zero experience, not as missing data');
  }

  // --- satisfaction: genuinely unavailable with no jobs ------------------------------------
  // THE CASE THIS MODULE EXISTS FOR. Today every service sits at total_fulfilled=0, so
  // avg_satisfaction is null across the board. Defaulting it to 1.0 would hand every unproven
  // agent a fifth of a perfect score for having done nothing.
  if (c.avgSatisfaction === null) {
    unavailable.push('satisfaction');
    notes.push('avg_satisfaction unavailable (no completed jobs) — omitted, not defaulted');
  } else {
    used.push({
      dimension: 'satisfaction',
      value: clamp01(c.avgSatisfaction),
      weight: WEIGHTS.satisfaction,
      evidence: `avg_satisfaction=${c.avgSatisfaction}`,
    });
  }

  // --- reliability: disputes relative to volume --------------------------------------------
  if (c.totalFulfilled === 0 && c.disputesTotal === 0) {
    unavailable.push('reliability');
    notes.push('no jobs and no disputes — nothing to infer reliability from');
  } else {
    const denom = Math.max(c.totalFulfilled, c.disputesTotal, 1);
    used.push({
      dimension: 'reliability',
      value: clamp01(1 - c.disputesTotal / denom),
      weight: WEIGHTS.reliability,
      evidence: `disputes=${c.disputesTotal} over ${denom}`,
    });
  }

  // --- settlement history -------------------------------------------------------------------
  if (c.settlementsSettled === null) {
    unavailable.push('settlement_history');
  } else {
    used.push({
      dimension: 'settlement_history',
      value: clamp01(c.settlementsSettled / EXPERIENCE_SATURATION),
      weight: WEIGHTS.settlement_history,
      evidence: `x402_settled=${c.settlementsSettled}`,
    });
  }

  // --- on-chain provenance -------------------------------------------------------------------
  if (c.onchainAttestations === null) {
    unavailable.push('onchain_provenance');
  } else {
    used.push({
      dimension: 'onchain_provenance',
      value: c.onchainAttestations > 0 ? 1 : 0,
      weight: WEIGHTS.onchain_provenance,
      evidence: `erc8004_attestations=${c.onchainAttestations}`,
    });
  }

  // --- weighted mean over what we HAVE, renormalised ------------------------------------------
  const usedWeight = used.reduce((s, d) => s + d.weight, 0);
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const base = usedWeight === 0 ? 0 : used.reduce((s, d) => s + d.value * d.weight, 0) / usedWeight;

  // --- asymmetric failure penalty, OUTSIDE the mean --------------------------------------------
  // A constraint, not a tradeable feature: 500 good jobs must not buy back a fabricated
  // deliverable. Each catastrophic failure halves the score and it cannot be earned back by volume.
  const failurePenalty = c.catastrophicFailures > 0 ? Math.pow(0.5, c.catastrophicFailures) : 1;
  if (c.catastrophicFailures > 0) {
    notes.push(
      `${c.catastrophicFailures} catastrophic failure(s) — x${failurePenalty.toFixed(3)} penalty, ` +
        `applied outside the mean so volume cannot offset it`,
    );
  }

  // --- recency: a note, never a silent multiplier ----------------------------------------------
  if (c.lastActivityAt === null) {
    notes.push('last activity unknown — recency not applied (never substitute "now")');
  } else {
    const days = (now - Date.parse(c.lastActivityAt)) / 86_400_000;
    if (Number.isFinite(days) && days > 90) {
      notes.push(`last verifiable activity ${Math.round(days)}d ago — treat freshness with caution`);
    }
  }

  return {
    agentId: c.agentId,
    agentName: c.agentName,
    score: clamp01(base * failurePenalty),
    coverage: totalWeight === 0 ? 0 : usedWeight / totalWeight,
    dimensionsUsed: used,
    dimensionsUnavailable: unavailable,
    dimensionsNotImplemented: NOT_YET_COMPUTABLE,
    failurePenalty,
    notes,
  };
}

export interface RankOptions {
  /** Reject candidates whose evidenced weight is below this. Default 0 = rank everything. */
  minCoverage?: number;
}

/**
 * Rank candidates best-first.
 *
 * Ties break on COVERAGE, not on score: between two equal scores, prefer the one that is better
 * evidenced. A well-evidenced 0.7 is a stronger claim than a thinly-evidenced 0.7, and ranking
 * should say so rather than resolving the tie arbitrarily.
 */
export function rankCandidates(
  candidates: readonly CandidateEvidence[],
  now: number,
  opts: RankOptions = {},
): SelectionScore[] {
  const min = opts.minCoverage ?? 0;
  return candidates
    .map((c) => scoreCandidate(c, now))
    .filter((s) => s.coverage >= min)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage);
}
