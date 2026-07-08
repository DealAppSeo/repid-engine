/**
 * participant-rating.ts — the participant-rating primitive (Trust Harness M3).
 *
 * WHAT THIS IS: the same machinery as the behavioral-integrity keystone, pointed
 * at PARTICIPANTS instead of CLAIMS. Nodes = agents / LLMs / SLMs / humans.
 * Edges = ratings. A rating edge is the un-gameable "who rated whom, verified how,
 * weighted why" record. RepID is (elsewhere) the reputation-weighted, ground-truth-
 * anchored score over the edge graph.
 *
 * DESIGN SOURCE: TRUST_HARNESS_SPRINT_AND_RATINGS.md Part C — the FIVE LAWS. This
 * module ENFORCES those laws in code (validateRatingEdge), it does not merely
 * describe them:
 *
 *   L1 EARNED-RATING GATE   — an edge is valid ONLY if it references a VERIFIED
 *                             engagement receipt. No receipt → the edge is rejected.
 *   L2 GROUND-TRUTH ANCHOR  — verification_strength (execution > quorum > peer-opinion
 *                             > self-report) drives the edge's weight.
 *   L3 RATER-REP-WEIGHT     — an edge counts ∝ the RATER's own calibrated RepID.
 *   L4 ANTI-GAMING          — collusion / comma-veto discount, family-disjoint check,
 *                             stake/consequence weighting, Sybil bond.
 *   L5 FAIRNESS             — multi-axis (never one collapsed score); every edge
 *                             carries its receipt ref (auditable).
 *
 * REUSE, not rebuild: the receipt reference is the same keccak256 hash-chain the
 * behavioral-integrity module and hashkey-chain.ts already produce; the RepID at
 * the raters is the same score the repid-update engine maintains. The rating graph
 * IS the harness, pointed at participants.
 *
 * ⚠ SECRET-FORMULA GUARD: the AGGREGATION here is a DOCUMENTED, PRINCIPLE-LEVEL
 * function (reputation-weighted, verification-strength-weighted, collusion-
 * discounted, decayed). It deliberately does NOT contain the secret RepID scoring
 * formula (T=floor(2000×log₁₀…)) or the ANFIS parameters — those never appear in
 * this module (see CLAUDE.md "Hard stops"). This is the edge-weighting shape, not
 * the RepID formula.
 *
 * This module is pure/deterministic and holds NO DB or network dependency, so it
 * is safe to run in the shadow-first path. The ledger writer (which DOES touch the
 * DB) lives in src/engine/participant-rating-ledger.ts and is shadow-gated.
 */

// ---------------------------------------------------------------------------
// L2 — verification-strength hierarchy (ground-truth anchor).
// Ground truth OUTRANKS opinion in every rating. This ordinal hierarchy is the
// backbone of the whole primitive: you cannot "act confident" past a failed unit
// test, so an execution-verified edge outweighs a peer opinion by construction.
// ---------------------------------------------------------------------------
export type VerificationStrength =
  | 'execution-verified' // passed a test / solver / on-chain check — the strongest
  | 'quorum-verified'    // a family-disjoint panel agreed vs evidence
  | 'peer-opinion'       // a single calibrated judge's opinion
  | 'self-report';       // an unverified self-assertion — the weakest

/**
 * The ordinal weight multiplier each verification strength contributes to an
 * edge (L2). Monotonic and strictly ordered: execution > quorum > peer > self.
 * These are principle-level anchors (a documented hierarchy), NOT the RepID
 * scoring formula. Self-report is deliberately near-zero: an unverified self-
 * assertion should barely move an aggregate.
 */
export const VERIFICATION_STRENGTH_WEIGHT: Record<VerificationStrength, number> = {
  'execution-verified': 1.0,
  'quorum-verified': 0.7,
  'peer-opinion': 0.4,
  'self-report': 0.1,
};

/** Strict ordinal rank (higher = stronger) — for the L2 ordering tests + compares. */
export const VERIFICATION_STRENGTH_RANK: Record<VerificationStrength, number> = {
  'execution-verified': 4,
  'quorum-verified': 3,
  'peer-opinion': 2,
  'self-report': 1,
};

// ---------------------------------------------------------------------------
// Participant + axes.
// ---------------------------------------------------------------------------
export type ParticipantKind = 'agent' | 'llm' | 'slm' | 'human';

export interface Participant {
  /** stable id: agent uuid, provider slug, model slug, or human id */
  id: string;
  kind: ParticipantKind;
  /** correlation family for the family-disjoint check (L4): e.g. an LLM's model
   *  family ('llama'/'glm'/'deepseek'), or an agent's operator. Optional for humans. */
  family?: string;
  /** the participant's current calibrated RepID, if known (drives L3 for a rater). */
  repId?: number;
}

/**
 * L5 — the multi-axis rating. NEVER collapsed into one score at the edge. Each
 * axis is optional (a task may not exercise every axis) and independently
 * auditable. Different tasks weight axes differently downstream; the edge just
 * carries the measured facets.
 */
export interface RatingAxes {
  /** factual accuracy vs a known-answer oracle (0..1). */
  accuracy?: number;
  /** calibration — does it abstain / lower confidence when unsure? (0..1). */
  calibration?: number;
  /** coverage / grounding — did it actually engage the full task? (0..1). */
  coverage?: number;
  /** latency in ms (lower better) — optional operational axis. */
  latency?: number;
  /** cost in USD for the engagement (lower better) — optional operational axis. */
  cost?: number;
}

export const RATING_AXES: readonly (keyof RatingAxes)[] = [
  'accuracy',
  'calibration',
  'coverage',
  'latency',
  'cost',
] as const;

/**
 * A rating EDGE: rater → ratee, on a set of axes, backed by a verified engagement
 * receipt. This is the atomic un-gameable unit. It is only VALID once it passes
 * the 5 laws (validateRatingEdge).
 */
export interface RatingEdge {
  rater: Participant;
  ratee: Participant;
  /** L5 — multi-axis, never a single collapsed number. */
  axes: RatingAxes;
  /** L2 — how the engagement was verified (drives weight). */
  verificationStrength: VerificationStrength;
  /**
   * L1 — reference to the VERIFIED engagement receipt (a hashkey-chain /
   * behavioral-integrity receipt hash, an on-chain tx, or a canary-run id + row).
   * REQUIRED: an edge with no receipt ref is rejected. This is the earned-gate.
   */
  engagementReceiptRef: string;
  /**
   * L4 — stake / consequence backing the engagement, in USD. A rating from a $50
   * verified settlement carries more weight than a $0.01 one. Default 0 (no
   * stake → no consequence bump, but the edge can still be valid if receipted).
   */
  stakeUsd?: number;
  /**
   * L4 — Sybil bond posted by the rater identity. When the anti-Sybil bond is
   * required (requireSybilBond in the policy) an unstaked rater's edges are
   * discounted/rejected. Default: treated as bonded=false unless set.
   */
  raterBonded?: boolean;
  /** free-text note (audit only; never load-bearing). */
  note?: string;
  /** when the engagement happened (for L-aggregation recency decay). */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Validation — the 5 laws as GATES. An edge that fails any hard gate is invalid.
// ---------------------------------------------------------------------------
export interface RatingEdgeValidation {
  valid: boolean;
  /** the codes of laws that REJECTED the edge (empty when valid). */
  violations: string[];
  /** non-fatal notes (e.g. a discount was applied but the edge still stands). */
  notes: string[];
}

export interface RatingPolicy {
  /**
   * L4 — require a posted Sybil bond for an edge to be admitted. When true, an
   * edge whose rater is not bonded (raterBonded !== true) is REJECTED, not merely
   * discounted. Default false (bond optional; unbonded edges are discounted in
   * aggregation instead — see UNBONDED_DISCOUNT).
   */
  requireSybilBond?: boolean;
}

/**
 * L1 EARNED-RATING GATE. Hard: a rating edge is valid ONLY if it references a
 * verified engagement receipt. This kills rating-farms — you cannot rate a
 * participant you never verifiably transacted with.
 */
export function hasVerifiedReceipt(edge: RatingEdge): boolean {
  return typeof edge.engagementReceiptRef === 'string' && edge.engagementReceiptRef.trim().length > 0;
}

/**
 * L4 — family-disjoint check over a batch. An LLM (or agent) cannot be the SOLE
 * rater of its own correlation family: correlated ≠ independent. Given all raters
 * of a ratee, an edge is family-conflicted when the rater shares the ratee's
 * family AND no rater from a DIFFERENT family exists in the set. Returns the
 * subset of edges that must be discounted/rejected for family-non-independence.
 */
export function assertFamilyDisjoint(edges: RatingEdge[]): {
  conflicted: RatingEdge[];
  reason: string;
} {
  const conflicted: RatingEdge[] = [];
  // group edges by ratee id
  const byRatee = new Map<string, RatingEdge[]>();
  for (const e of edges) {
    const arr = byRatee.get(e.ratee.id) ?? [];
    arr.push(e);
    byRatee.set(e.ratee.id, arr);
  }
  for (const [, group] of byRatee) {
    const familiesPresent = new Set(
      group.map((e) => e.rater.family).filter((f): f is string => !!f),
    );
    for (const e of group) {
      const rf = e.rater.family;
      const tf = e.ratee.family;
      if (rf && tf && rf === tf) {
        // rater is same-family as ratee — needs at least one DIFFERENT-family
        // rater in the set to be independently corroborated.
        const hasIndependent = [...familiesPresent].some((f) => f !== rf);
        if (!hasIndependent) conflicted.push(e);
      }
    }
  }
  return {
    conflicted,
    reason:
      'family-non-independence (L4): a participant cannot be the SOLE rater of its own correlation family',
  };
}

/**
 * Validate a single rating edge against the 5 laws. HARD gates that make an edge
 * INVALID:
 *   - L1: no verified receipt ref  → REJECT.
 *   - L2: an unknown/invalid verification strength → REJECT (can't weight it).
 *   - L5: no axes provided at all → REJECT (a rating with zero measured axes is
 *         not a rating). Note: we do NOT collapse the axes — we only require ≥1.
 *   - L4 (policy): requireSybilBond && !raterBonded → REJECT.
 * SOFT notes (edge stays valid, but aggregation will discount it):
 *   - L4: rater==ratee (self-report) — allowed, but self-report is near-zero weight.
 *   - L4: same-family rater/ratee — flagged for the family-disjoint batch check.
 */
export function validateRatingEdge(edge: RatingEdge, policy: RatingPolicy = {}): RatingEdgeValidation {
  const violations: string[] = [];
  const notes: string[] = [];

  // L1 — earned-rating gate (hard).
  if (!hasVerifiedReceipt(edge)) {
    violations.push('L1:no-verified-receipt');
  }

  // L2 — ground-truth anchor: the verification strength must be a known tier.
  if (!(edge.verificationStrength in VERIFICATION_STRENGTH_WEIGHT)) {
    violations.push('L2:unknown-verification-strength');
  }

  // L5 — fairness / multi-axis: at least one axis must be measured, and we never
  // collapse them. An edge with an entirely empty axes object measures nothing.
  const measuredAxes = RATING_AXES.filter((a) => edge.axes[a] !== undefined && edge.axes[a] !== null);
  if (measuredAxes.length === 0) {
    violations.push('L5:no-axes-measured');
  }

  // L4 — anti-gaming: Sybil bond (policy-gated hard) + self/family notes.
  if (policy.requireSybilBond && edge.raterBonded !== true) {
    violations.push('L4:sybil-bond-required');
  }
  if (edge.rater.id === edge.ratee.id) {
    notes.push('L4:self-report (allowed, near-zero weight)');
  }
  if (edge.rater.family && edge.ratee.family && edge.rater.family === edge.ratee.family) {
    notes.push('L4:same-family-rater (needs an independent-family corroborator — batch-checked)');
  }

  return { valid: violations.length === 0, violations, notes };
}

// ---------------------------------------------------------------------------
// L3 + L4 — per-edge WEIGHT. This is the edge-weighting shape (principle-level),
// NOT the RepID scoring formula. It composes:
//   base            = L2 verification-strength weight (execution > … > self)
//   × raterRepWeight (L3) — ∝ the rater's own RepID (log-damped, bounded)
//   × stakeWeight    (L4) — a consequence bump for a real settlement
//   × collusionDisc  (L4) — 1.0 unless the edge is in a collusion/comma-veto set
//   × sybilDisc      (L4) — a discount for an unbonded rater (when not hard-gated)
//   × recencyDecay        — older engagements weigh less (aggregation recency)
// All factors are in [0,1]-ish bounded ranges and documented; none encode the
// secret RepID formula.
// ---------------------------------------------------------------------------

/** Aggregation defaults (documented knobs, not the RepID formula). */
export const UNBONDED_DISCOUNT = 0.5;
/** collusion / comma-veto discount applied when an edge is flagged contaminated. */
export const COLLUSION_DISCOUNT = 0.25;
/** recency half-life (days) used by the decay factor. */
export const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * L3 — rater-reputation weight. A rating counts ∝ the rater's own calibrated
 * RepID. Log-damped and bounded so a whale rater cannot dominate and an unknown
 * rater (no RepID) still carries a small floor. This is a documented monotone
 * shape (more rater RepID ⇒ more weight), NOT the secret RepID formula.
 *
 * Bounds: repId 0/undefined → floor (0.1); grows with log10(repId) up to a cap.
 */
export function raterReputationWeight(raterRepId: number | undefined): number {
  const r = typeof raterRepId === 'number' && raterRepId > 0 ? raterRepId : 0;
  if (r <= 0) return 0.1; // unknown/zero-rep rater floor — small but non-zero
  // log10-damped, normalized so ~1000 RepID (ESTABLISHED floor) ≈ 0.6, capped at 1.0.
  const w = Math.log10(r + 1) / Math.log10(10001);
  return Math.max(0.1, Math.min(1.0, w));
}

/**
 * L4 — stake / consequence weight. Diminishing-returns bump for a real settlement
 * backing the engagement. A $0 edge gets 1.0 (no bump, no penalty); a $50 edge
 * gets a bounded bonus. Never below 1.0 (stake only adds confidence).
 */
export function stakeWeight(stakeUsd: number | undefined): number {
  const s = typeof stakeUsd === 'number' && stakeUsd > 0 ? stakeUsd : 0;
  if (s <= 0) return 1.0;
  // +log10 bump, capped at +0.5 (so 1.0..1.5). $50 → ~+0.4.
  return 1.0 + Math.min(0.5, Math.log10(1 + s) / Math.log10(1 + 1000));
}

/** Recency decay — exponential half-life. now defaults to Date.now(). */
export function recencyDecay(timestamp: string | undefined, now: number = Date.now()): number {
  if (!timestamp) return 1.0;
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return 1.0;
  const ageDays = Math.max(0, (now - t) / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export interface EdgeWeightBreakdown {
  base: number;          // L2 verification-strength weight
  raterRepWeight: number; // L3
  stakeWeight: number;    // L4
  collusionDiscount: number; // L4
  sybilDiscount: number;  // L4
  recencyDecay: number;
  /** the composed final weight (product of the factors). */
  weight: number;
}

/**
 * Compute an edge's aggregation weight (principle-level, documented). `flags`
 * lets the caller mark an edge as collusion-contaminated (from the comma-veto /
 * too-perfect-agreement check) or the rater as unbonded when the Sybil bond is
 * NOT hard-required (so the edge is discounted rather than rejected).
 */
export function edgeWeight(
  edge: RatingEdge,
  flags: { collusionContaminated?: boolean; unbondedDiscount?: boolean } = {},
  now: number = Date.now(),
): EdgeWeightBreakdown {
  const base = VERIFICATION_STRENGTH_WEIGHT[edge.verificationStrength] ?? 0;
  const raterRep = raterReputationWeight(edge.rater.repId);
  const stake = stakeWeight(edge.stakeUsd);
  const collusion = flags.collusionContaminated ? COLLUSION_DISCOUNT : 1.0;
  const sybil = flags.unbondedDiscount && edge.raterBonded !== true ? UNBONDED_DISCOUNT : 1.0;
  const recency = recencyDecay(edge.timestamp, now);
  const weight = base * raterRep * stake * collusion * sybil * recency;
  return {
    base,
    raterRepWeight: raterRep,
    stakeWeight: stake,
    collusionDiscount: collusion,
    sybilDiscount: sybil,
    recencyDecay: recency,
    weight,
  };
}

// ---------------------------------------------------------------------------
// AGGREGATION — principle-level, NOT the secret RepID formula.
// ---------------------------------------------------------------------------

export interface AggregatedRating {
  ratee: Participant;
  /** per-axis reputation+verification-weighted mean (never one collapsed score). */
  axes: Partial<Record<keyof RatingAxes, number>>;
  /** the total weight of the VALID edges that fed this aggregate. */
  totalWeight: number;
  /** how many valid edges contributed. */
  edgeCount: number;
  /** the receipt refs of every contributing edge (L5 auditability). */
  receiptRefs: string[];
}

/**
 * L4 — collusion / comma-veto detector. Too-perfect agreement among a rater set
 * on the SAME axis is a contamination signal (CANON P-003, the Pythagorean-comma
 * veto): high-confidence agreement can signal coordinated dissonance, not truth.
 * Returns the set of edges to discount when their pairwise axis values are
 * suspiciously identical AND come from ≥3 raters. Deterministic + interpretable.
 */
export function detectCollusion(
  edges: RatingEdge[],
  axis: keyof RatingAxes = 'accuracy',
  epsilon = 1e-9,
): { contaminated: RatingEdge[]; reason: string } {
  const withAxis = edges.filter((e) => typeof e.axes[axis] === 'number');
  if (withAxis.length < 3) {
    return { contaminated: [], reason: 'too few raters to judge collusion (<3)' };
  }
  const values = withAxis.map((e) => e.axes[axis] as number);
  const allIdentical = values.every((v) => Math.abs(v - values[0]!) < epsilon);
  if (allIdentical) {
    return {
      contaminated: withAxis,
      reason: `comma-veto (L4/P-003): ${withAxis.length} raters gave identical ${axis} — too-perfect agreement flagged as contamination`,
    };
  }
  return { contaminated: [], reason: 'no comma-veto contamination detected' };
}

/**
 * AGGREGATE a ratee's incoming edges into a multi-axis rating (DESIGN PRINCIPLE).
 *
 * This is reputation-weighted, verification-strength-weighted, collusion-
 * discounted, Sybil-gated, recency-decayed — an eigenvector-STYLE reduction over
 * the verified-edge graph, expressed here as a single-hop weighted mean per axis.
 * It is intentionally the SHAPE of the aggregation, not the secret RepID formula:
 * it emits per-axis weighted means (which never become a single RepID here). The
 * RepID engine consumes these signals elsewhere with the proprietary formula that
 * does NOT live in this module (CLAUDE.md hard stop).
 *
 * Invalid edges (fail the 5 laws) are EXCLUDED — never averaged in. Family-non-
 * independent edges (L4) and comma-veto-contaminated edges are discounted.
 */
export function aggregateRatings(
  ratee: Participant,
  edges: RatingEdge[],
  opts: { policy?: RatingPolicy; unbondedDiscount?: boolean; now?: number } = {},
): AggregatedRating {
  const now = opts.now ?? Date.now();
  const incoming = edges.filter((e) => e.ratee.id === ratee.id);

  // 1 — L1/L2/L5 hard gate: drop invalid edges entirely.
  const valid = incoming.filter((e) => validateRatingEdge(e, opts.policy).valid);

  // 2 — L4 family-disjoint: mark same-family-sole-rater edges as contaminated.
  const familyConflicted = new Set(assertFamilyDisjoint(valid).conflicted);

  // 3 — L4 comma-veto: mark too-perfect-agreement edges as contaminated (per axis).
  const collusionSet = new Set<RatingEdge>();
  for (const axis of RATING_AXES) {
    for (const e of detectCollusion(valid, axis).contaminated) collusionSet.add(e);
  }

  // 4 — weighted per-axis accumulation.
  const axisSum: Partial<Record<keyof RatingAxes, number>> = {};
  const axisWeight: Partial<Record<keyof RatingAxes, number>> = {};
  let totalWeight = 0;
  const receiptRefs: string[] = [];

  for (const e of valid) {
    const w = edgeWeight(
      e,
      {
        collusionContaminated: collusionSet.has(e) || familyConflicted.has(e),
        unbondedDiscount: opts.unbondedDiscount,
      },
      now,
    ).weight;
    totalWeight += w;
    receiptRefs.push(e.engagementReceiptRef);
    for (const axis of RATING_AXES) {
      const v = e.axes[axis];
      if (typeof v === 'number') {
        axisSum[axis] = (axisSum[axis] ?? 0) + v * w;
        axisWeight[axis] = (axisWeight[axis] ?? 0) + w;
      }
    }
  }

  const axes: Partial<Record<keyof RatingAxes, number>> = {};
  for (const axis of RATING_AXES) {
    const ws = axisWeight[axis];
    if (ws && ws > 0) axes[axis] = (axisSum[axis] as number) / ws;
  }

  return {
    ratee,
    axes,
    totalWeight,
    edgeCount: valid.length,
    receiptRefs,
  };
}
