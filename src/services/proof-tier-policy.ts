/**
 * proof-tier-policy.ts — backlog #11: proof strength as a FIRST-CLASS ANFIS policy output.
 *
 * PATENT #2 KEYSTONE ("policy-gated proof-tier selection via a unified ANFIS/LASSO
 * fabric"): the same policy fabric that picks the provider/tier for a call also picks
 * the *cryptographic proof strength* that call's answer must carry. One model, two
 * kinds of output — routing and proof obligation — from one feature vector.
 *
 * The 5 policy axes are the ANFIS input vector (and the fabric is literally the one in
 * `anfis-comma.ts`, reused, not a parallel copy — that shared fabric IS the claim):
 *   x[0] stakes               — economic/reputational consequence of being wrong
 *   x[1] costPressure         — budget scarcity right now (higher ⇒ prefer cheaper proof)
 *   x[2] privacy              — sensitivity of the underlying content
 *   x[3] latencyUrgency       — how much the caller needs an answer now
 *   x[4] reliabilityRequired  — required correctness floor for this call
 *
 * TWO-LAYER DESIGN — this split is the point, and it is what makes the learned layer
 * safe to ship:
 *   1. a LEARNED layer (ANFIS + LASSO) *selects* a tier from the ladder; and
 *   2. a DETERMINISTIC FLOOR *gates* it — the learned layer may always select a
 *      STRONGER proof than the floor, and can never select a weaker one.
 * So a mis-tuned, drifted, or adversarially-fed policy can waste money; it cannot
 * silently under-prove a high-stakes claim. (Cf. the L0/L2 safety gates: the learned
 * component is never the last thing standing between a claim and its proof.)
 *
 * SHADOW-FIRST / INERT: this module is a pure function plus a shadow comparator. It is
 * wired into no live path, reads no env flag, and changes no behaviour. Measurement
 * (`shadowCompareProofTier`) comes first; enforcement is a later, Sean-gated step.
 */

import { goldenCenters, goldenSpreads, anfisForward } from './anfis-comma';

// ── The proof ladder ──────────────────────────────────────────────────────────
// Ordered by strength AND by cost; index is meaningful and is compared numerically.
export const PROOF_TIERS = [
  'none',               // 0 — assert without cryptographic backing (low stakes, cheap)
  'inclusion',          // 1 — the cited fact is in the committed memory root
  'current_validity',   // 2 — inclusion + non-membership of its retraction (still true NOW)
  'authenticated_walk', // 3 — a multi-hop GraphRAG walk verified hop-by-hop to the root
  'ranking_integrity',  // 4 — plus a proof the top-k selection itself was correct
] as const;
export type ProofTier = (typeof PROOF_TIERS)[number];

/** Relative cost/latency of each rung. Strictly increasing — asserted in tests. */
export const TIER_COST_UNITS = [0, 1, 3, 12, 40] as const;
export const TIER_LATENCY_MS = [0, 15, 45, 260, 900] as const;

export interface PolicyAxes {
  stakes: number;
  costPressure: number;
  privacy: number;
  latencyUrgency: number;
  reliabilityRequired: number;
}

export interface ProofTierDecision {
  tier: ProofTier;
  tierIndex: number;
  /** Content is sensitive enough to require a ZK property proof rather than a plaintext
   *  citation (ZKP_ARCHITECTURE_INVARIANTS 2/4: domain-scoped nullifiers, PHI never in
   *  the clear). Orthogonal to the ladder — a tier says how strongly, this says whether
   *  the evidence may be revealed at all. */
  zkRequired: boolean;
  confidence: number;
  /** LASSO-selected axis names — which axes actually drove this decision. Interpretability
   *  is not decoration here: it is the enabling disclosure for the filing. */
  drivers: string[];
  expectedCostUnits: number;
  expectedLatencyMs: number;
  /** True when the deterministic floor overrode a weaker learned selection. */
  floorApplied: boolean;
  /** True when the latency/cost ceiling capped a stronger learned selection. */
  ceilingApplied: boolean;
  /** The tier the learned layer chose before floor/ceiling — kept so the gate's effect
   *  is measurable rather than invisible. */
  learnedTierIndex: number;
  rationale: string;
}

const AXIS_NAMES = ['stakes', 'costPressure', 'privacy', 'latencyUrgency', 'reliabilityRequired'];

// ── Deterministic gates ───────────────────────────────────────────────────────
export const HIGH_STAKES_FLOOR = 0.7;   // ⇒ current_validity: a consequential claim must be proven CURRENT
export const ANY_STAKES_FLOOR = 0.35;   // ⇒ inclusion: any real consequence needs at least a citation proof
export const RELIABILITY_FLOOR = 0.8;   // ⇒ current_validity
export const PRIVACY_ZK_THRESHOLD = 0.6;
export const URGENT_LATENCY = 0.85;     // ⇒ cap at current_validity unless the floor is higher

/** The floor is a pure, monotone-nondecreasing function of stakes and reliability. */
export function floorTierIndex(a: PolicyAxes): number {
  let floor = 0;
  if (a.stakes >= ANY_STAKES_FLOOR) floor = 1;
  if (a.stakes >= HIGH_STAKES_FLOOR) floor = 2;
  if (a.reliabilityRequired >= RELIABILITY_FLOOR) floor = Math.max(floor, 2);
  return floor;
}

/** LASSO-like sparse selection: name the axes whose weighted magnitude clears τ. */
function lassoDrivers(feats: number[], threshold = 0.18): string[] {
  // Importance reflects what actually moves a proof obligation: consequence and required
  // correctness dominate; urgency and budget shave cost at the margin.
  const importance = [1.0, 0.75, 0.7, 0.6, 0.95];
  return feats
    .map((f, i) => ({ i, w: Math.abs(f * (importance[i] as number)) }))
    .filter((d) => d.w > threshold)
    .sort((x, y) => y.w - x.w)
    .map((d) => AXIS_NAMES[d.i] as string);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The learned layer. Consequents push UP on stakes/reliability/privacy and DOWN on
 * costPressure/latencyUrgency; the gaussian antecedents make the response non-linear
 * (a fixed linear rule table would not need ANFIS at all).
 */
const RULE_PARAMS: number[][] = [
  //  stakes  cost  privacy  latency  reliab   bias
  [1.20, -0.80, 0.30, -0.50, 0.90, 0.05],
  [1.00, -1.00, 0.25, -0.60, 0.80, 0.00],
  [1.40, -0.60, 0.35, -0.40, 1.00, 0.10],
  [0.90, -0.90, 0.20, -0.70, 0.70, -0.05],
  [1.30, -0.70, 0.30, -0.45, 0.95, 0.08],
];

/** Quantiser: squashed score → ladder rung. */
const TIER_THRESHOLDS = [0.20, 0.38, 0.60, 0.82];

function quantise(score: number): number {
  let idx = 0;
  for (const t of TIER_THRESHOLDS) if (score >= t) idx++;
  return idx;
}

/**
 * Select the required proof tier for a call.
 * Pure and deterministic: same axes in ⇒ byte-identical decision out.
 */
export function selectProofTier(axesIn: PolicyAxes): ProofTierDecision {
  const axes: PolicyAxes = {
    stakes: clamp01(axesIn.stakes),
    costPressure: clamp01(axesIn.costPressure),
    privacy: clamp01(axesIn.privacy),
    latencyUrgency: clamp01(axesIn.latencyUrgency),
    reliabilityRequired: clamp01(axesIn.reliabilityRequired),
  };
  const feats = [
    axes.stakes,
    axes.costPressure,
    axes.privacy,
    axes.latencyUrgency,
    axes.reliabilityRequired,
  ];

  const centers = goldenCenters(5);
  const spreads = goldenSpreads(5);
  const { output, ruleWeights } = anfisForward(feats, centers, spreads, RULE_PARAMS);

  // Squash the unbounded consequent sum into (0,1) so the quantiser is well-defined
  // regardless of consequent scale.
  const score = 1 / (1 + Math.exp(-2.4 * (output - 0.55)));
  const learnedTierIndex = quantise(score);

  // ── Gate the learned selection ──────────────────────────────────────────────
  const floor = floorTierIndex(axes);
  // The ceiling may never sit below the floor — safety wins over thrift, always.
  // NOTE: this Math.max is currently a no-op and is UNTESTABLE by construction —
  // `floorTierIndex` maxes out at 2 and the urgent ceiling is exactly 2, so the two can
  // never cross today. A mutation replacing it with `rawCeiling` survives the whole
  // suite for that reason. It is kept deliberately: it is the invariant that must hold
  // if any future floor rung is raised above `current_validity`, and discovering that
  // by way of an under-proven high-stakes claim would be the worst way to find out.
  const rawCeiling = axes.latencyUrgency >= URGENT_LATENCY ? 2 : PROOF_TIERS.length - 1;
  const ceiling = Math.max(rawCeiling, floor);

  let tierIndex = learnedTierIndex;
  const floorApplied = tierIndex < floor;
  if (floorApplied) tierIndex = floor;
  const ceilingApplied = tierIndex > ceiling;
  if (ceilingApplied) tierIndex = ceiling;

  const drivers = lassoDrivers(feats);
  const zkRequired = axes.privacy >= PRIVACY_ZK_THRESHOLD;

  // Confidence = how decisively the score sits inside its bucket, tempered by rule
  // agreement. A score parked on a threshold should not read as certain.
  const maxWeight = ruleWeights.reduce((m: number, w: number) => (w > m ? w : m), 0);
  const edges = [0, ...TIER_THRESHOLDS, 1];
  const lo = edges[learnedTierIndex] as number;
  const hi = edges[learnedTierIndex + 1] as number;
  const mid = (lo + hi) / 2;
  const halfWidth = (hi - lo) / 2 || 1;
  const centrality = 1 - Math.abs(score - mid) / halfWidth;
  const confidence = Number(
    Math.max(0.5, Math.min(0.95, 0.5 + 0.3 * centrality + 0.15 * maxWeight)).toFixed(4),
  );

  const rationale = floorApplied
    ? `floor: stakes=${axes.stakes.toFixed(2)}/reliability=${axes.reliabilityRequired.toFixed(2)} force ≥ ${PROOF_TIERS[floor]}`
    : ceilingApplied
      ? `ceiling: latencyUrgency=${axes.latencyUrgency.toFixed(2)} caps at ${PROOF_TIERS[ceiling]}`
      : `learned: score=${score.toFixed(3)} → ${PROOF_TIERS[tierIndex]}`;

  return {
    tier: PROOF_TIERS[tierIndex] as ProofTier,
    tierIndex,
    zkRequired,
    confidence,
    drivers,
    expectedCostUnits: TIER_COST_UNITS[tierIndex] as number,
    expectedLatencyMs: TIER_LATENCY_MS[tierIndex] as number,
    floorApplied,
    ceilingApplied,
    learnedTierIndex,
    rationale,
  };
}

/**
 * Shadow comparator — measure the policy against whatever tier is in force today
 * WITHOUT changing behaviour. Mirrors `computeShadowDecision` in anfis-router.ts so
 * both halves of the unified fabric are measured the same way.
 */
export function shadowCompareProofTier(
  currentTier: ProofTier,
  axes: PolicyAxes,
): {
  current: { tier: ProofTier; index: number; costUnits: number };
  policy: ProofTierDecision;
  delta: 'same' | 'stronger' | 'weaker';
  costDeltaUnits: number;
} {
  const currentIndex = PROOF_TIERS.indexOf(currentTier);
  const policy = selectProofTier(axes);
  const delta =
    policy.tierIndex === currentIndex ? 'same' : policy.tierIndex > currentIndex ? 'stronger' : 'weaker';
  return {
    current: {
      tier: currentTier,
      index: currentIndex,
      costUnits: TIER_COST_UNITS[currentIndex] as number,
    },
    policy,
    delta,
    costDeltaUnits: (TIER_COST_UNITS[policy.tierIndex] as number) - (TIER_COST_UNITS[currentIndex] as number),
  };
}
