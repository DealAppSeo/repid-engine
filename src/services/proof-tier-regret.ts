/**
 * proof-tier-regret.ts — measured regret for the proof-tier policy (Patent #2).
 *
 * The backlog's enabling-disclosure note asks for the ANFIS half of the fabric to carry
 * "measured cost/reliability numbers ... ANFIS regret vs shadow", not only properties.
 * #225 proved properties (safety floor, monotonicity, reachability) over a 32,768-point
 * grid. A grid cannot produce regret, because regret needs a notion of what the RIGHT
 * answer was, and the grid has none. This adds that: a hand-labelled corpus
 * (`proof-tier-corpus.ts`, committed before this file existed) supplies the oracle.
 *
 * THE ABLATION THAT MATTERS. Patent #2 claims a UNIFIED LEARNED FABRIC selects proof
 * strength. The honest test of that claim is not "does the policy do well" — a
 * deterministic floor alone might do just as well, in which case the learned layer is
 * decoration and the claim is weaker than stated. So `floor_only` is measured as a
 * first-class competitor, and `learned_only` measures what the gates buy. If floor_only
 * ties the full policy, that is the finding and it gets reported as such.
 *
 * SCORING, stated so it can be argued with:
 *   under-proof  = selected rung < required rung. A safety failure: the answer went out
 *                  with weaker cryptographic backing than its own content needed.
 *   over-proof   = selected > required. Waste, priced in TIER_COST_UNITS.
 *   regret       = over-proof cost + UNDER_PROOF_PRICE x under-proof count.
 * The two are NOT commensurable in reality — shipping an under-proven escrow release is
 * not "40 cost units" of bad. Any single scalar hides that, so the scalar is reported at
 * three prices and the two components are always reported separately alongside it. A
 * ranking that only holds at one price is an artifact of the price, not a result.
 *
 * Read-only, offline, no network, no env flags, no DB. Run:
 *   npx tsx scripts/measure/proof-tier-regret.ts
 */

import {
  PROOF_TIERS,
  TIER_COST_UNITS,
  selectProofTier,
  floorTierIndex,
  type PolicyAxes,
} from './proof-tier-policy';
import { PROOF_TIER_CORPUS, type CorpusScenario } from './proof-tier-corpus';

export const UNDER_PROOF_PRICES = [10, 40, 200] as const;

type Strategy = { name: string; note: string; select: (a: PolicyAxes) => number };

const STRATEGIES: Strategy[] = [
  { name: 'always_none', note: 'never prove anything', select: () => 0 },
  {
    name: 'always_max',
    note: 'prove everything maximally',
    select: () => PROOF_TIERS.length - 1,
  },
  {
    name: 'fixed_current_validity',
    note: 'one static default for every call (the shadow baseline)',
    select: () => 2,
  },
  {
    name: 'floor_only',
    note: 'deterministic gates alone — no learned layer (THE ablation)',
    select: (a) => floorTierIndex(a),
  },
  {
    name: 'learned_only',
    note: 'ANFIS selection with the floor/ceiling gates removed',
    select: (a) => selectProofTier(a).learnedTierIndex,
  },
  {
    name: 'policy',
    note: 'the shipped two-layer decision (learned, then gated)',
    select: (a) => selectProofTier(a).tierIndex,
  },
];

export interface StrategyResult {
  name: string;
  note: string;
  exact: number;
  underProof: number;
  underProofIds: string[];
  overProof: number;
  overProofCostUnits: number;
  totalCostUnits: number;
  regretAtPrice: Record<number, number>;
}

export const requiredIndexOf = (s: CorpusScenario): number => PROOF_TIERS.indexOf(s.requiredTier as never);

export function scoreStrategy(strategy: Strategy, corpus: CorpusScenario[]): StrategyResult {
  let exact = 0;
  let underProof = 0;
  let overProof = 0;
  let overProofCostUnits = 0;
  let totalCostUnits = 0;
  const underProofIds: string[] = [];

  for (const s of corpus) {
    const required = requiredIndexOf(s);
    const selected = strategy.select(s.axes);
    totalCostUnits += TIER_COST_UNITS[selected] as number;
    if (selected === required) exact++;
    else if (selected < required) {
      underProof++;
      underProofIds.push(s.id);
    } else {
      overProof++;
      overProofCostUnits += (TIER_COST_UNITS[selected] as number) - (TIER_COST_UNITS[required] as number);
    }
  }

  const regretAtPrice: Record<number, number> = {};
  for (const p of UNDER_PROOF_PRICES) regretAtPrice[p] = overProofCostUnits + p * underProof;

  return {
    name: strategy.name,
    note: strategy.note,
    exact,
    underProof,
    underProofIds,
    overProof,
    overProofCostUnits,
    totalCostUnits,
    regretAtPrice,
  };
}

/**
 * The price of an under-proof at which two strategies tie.
 *
 * regret(s, p) = overProofCost(s) + p * underProof(s) is affine in p, so any two
 * strategies cross at most once and the crossing is exact rather than searched for.
 * This is the number worth disclosing: it converts "the policy is better" — which is
 * only true over a band — into "the policy is better IFF an under-proven claim costs
 * more than X", which is falsifiable and which a reader can price for themselves.
 *
 * Returns null when the lines are parallel (equal under-proof counts): then one
 * strategy dominates at every price, or they never separate.
 */
export function crossoverPrice(a: StrategyResult, b: StrategyResult): number | null {
  const du = a.underProof - b.underProof;
  if (du === 0) return null;
  const p = (b.overProofCostUnits - a.overProofCostUnits) / du;
  return p > 0 ? p : null;
}

export function runRegretMeasurement(corpus: CorpusScenario[] = PROOF_TIER_CORPUS): {
  results: StrategyResult[];
  oracleCostUnits: number;
  n: number;
  /** How often the deterministic floor was the binding constraint on real scenarios. */
  floorFirings: number;
  ceilingFirings: number;
} {
  const oracleCostUnits = corpus.reduce(
    (sum, s) => sum + (TIER_COST_UNITS[requiredIndexOf(s)] as number),
    0,
  );
  let floorFirings = 0;
  let ceilingFirings = 0;
  for (const s of corpus) {
    const d = selectProofTier(s.axes);
    if (d.floorApplied) floorFirings++;
    if (d.ceilingApplied) ceilingFirings++;
  }
  return {
    results: STRATEGIES.map((st) => scoreStrategy(st, corpus)),
    oracleCostUnits,
    n: corpus.length,
    floorFirings,
    ceilingFirings,
  };
}
