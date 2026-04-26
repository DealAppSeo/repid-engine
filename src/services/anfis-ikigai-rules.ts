/**
 * ANFIS-Ikigai — Sugeno-style Rule Base (v0)
 *
 * Encodes the seven seed rules that map fuzzified ikigai-dimension scores
 * into a composite alignment score. The rule base is patent-relevant
 * (P-014): Rule 6 in particular is the anti-engagement-economy filter that
 * differentiates this from standard recommender systems.
 *
 * Sugeno style: each consequent is a constant numeric value (zero-order
 * Takagi-Sugeno). The composite score is the firing-strength-weighted
 * average of all consequents:
 *
 *     composite = sum(rule_weight_i * firing_strength_i * consequent_i)
 *               / sum(rule_weight_i * firing_strength_i)
 *
 * Firing strength of a rule is the min() of its antecedent membership
 * values (T-norm = min, classical Mamdani/Sugeno default). If no rule
 * fires (all zero), the composite collapses to 0 by convention — that
 * means "no opinion", not "low alignment".
 *
 * Rule weights default to 1.0 in v0. v1 LASSO will tune them; the column
 * exists in anfis_rule_base for that reason.
 */

import { FuzzySet, IkigaiDimension, membershipTriple } from './anfis-ikigai-mfs';

export interface RuleAntecedent {
  dimension: IkigaiDimension;
  fuzzySet: FuzzySet;
}

export interface IkigaiRule {
  /** Stable identifier — matches the rule numbers in the docs. */
  id: string;
  /** Human-readable IF-THEN form, suitable for rule_text in the DB. */
  text: string;
  /** Why this rule exists. Goes into rule_trace and the patent doc. */
  explanation: string;
  /** AND-conjoined antecedents. Empty list means "always fires" (forbidden). */
  antecedents: RuleAntecedent[];
  /** Numeric output contribution in [0, 1]. */
  consequent: number;
  /** LASSO-tunable weight; v0 default is 1.0. */
  weight: number;
}

export const V0_RULE_BASE: IkigaiRule[] = [
  // --------------------------------------------------------------------
  // Rule 1 — Full Ikigai Match
  {
    id: 'R1_full_ikigai',
    text:
      'IF love=high AND good_at=high AND world_needs=high AND paid_for=high ' +
      'THEN composite_score = 0.95',
    explanation:
      'Rare four-circle convergence — love, skill, world need, and ' +
      'sustainability all align. Highest priority surface.',
    antecedents: [
      { dimension: 'love',        fuzzySet: 'high' },
      { dimension: 'good_at',     fuzzySet: 'high' },
      { dimension: 'world_needs', fuzzySet: 'high' },
      { dimension: 'paid_for',    fuzzySet: 'high' },
    ],
    consequent: 0.95,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 2 — Vocation Alignment (love + good_at + moderate world_needs)
  {
    id: 'R2_vocation',
    text:
      'IF love=high AND good_at=high AND world_needs=medium ' +
      'THEN composite_score = 0.80',
    explanation:
      'Strong personal-skills alignment with moderate external demand. ' +
      'Classic vocation: useful work the person is good at and loves.',
    antecedents: [
      { dimension: 'love',        fuzzySet: 'high' },
      { dimension: 'good_at',     fuzzySet: 'high' },
      { dimension: 'world_needs', fuzzySet: 'medium' },
    ],
    consequent: 0.80,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 3 — Mission Alignment (love + world_needs)
  {
    id: 'R3_mission',
    text:
      'IF love=high AND world_needs=high THEN composite_score = 0.75',
    explanation:
      'Heart + impact: the user cares deeply about a real-world problem. ' +
      'Pay and skill secondary — mission-driven attention.',
    antecedents: [
      { dimension: 'love',        fuzzySet: 'high' },
      { dimension: 'world_needs', fuzzySet: 'high' },
    ],
    consequent: 0.75,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 4 — Profession Alignment (good_at + paid_for)
  {
    id: 'R4_profession',
    text:
      'IF good_at=high AND paid_for=high THEN composite_score = 0.65',
    explanation:
      'Skill + sustainability. Lower meaning (no love/world_needs check), ' +
      'but worth surfacing — this is how bills get paid.',
    antecedents: [
      { dimension: 'good_at',  fuzzySet: 'high' },
      { dimension: 'paid_for', fuzzySet: 'high' },
    ],
    consequent: 0.65,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 5 — Passion Alignment (love + medium good_at)
  {
    id: 'R5_passion',
    text:
      'IF love=high AND good_at=medium THEN composite_score = 0.55',
    explanation:
      'Energy + capability gap. Worth surfacing because growth is likely; ' +
      'the user already cares enough to learn.',
    antecedents: [
      { dimension: 'love',    fuzzySet: 'high' },
      { dimension: 'good_at', fuzzySet: 'medium' },
    ],
    consequent: 0.55,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 6 — Engagement Trap (NEGATIVE — patent-relevant)
  {
    id: 'R6_engagement_trap',
    text:
      'IF love=high AND good_at=low AND world_needs=low ' +
      'THEN composite_score = 0.20',
    explanation:
      'Engaging but unproductive — pure dopamine. This is the rule that ' +
      'differentiates ANFIS-Ikigai from engagement-maximising recommenders. ' +
      'P-014 anti-engagement-economy filter.',
    antecedents: [
      { dimension: 'love',        fuzzySet: 'high' },
      { dimension: 'good_at',     fuzzySet: 'low' },
      { dimension: 'world_needs', fuzzySet: 'low' },
    ],
    consequent: 0.20,
    weight: 1.0,
  },

  // --------------------------------------------------------------------
  // Rule 7 — Burnout Risk (NEGATIVE)
  {
    id: 'R7_burnout',
    text:
      'IF good_at=high AND paid_for=high AND love=low AND world_needs=low ' +
      'THEN composite_score = 0.30',
    explanation:
      'Pure transactional alignment — capable, paid, but no meaning or ' +
      'mission. High burnout risk; deprioritise to surface less.',
    antecedents: [
      { dimension: 'good_at',     fuzzySet: 'high' },
      { dimension: 'paid_for',    fuzzySet: 'high' },
      { dimension: 'love',        fuzzySet: 'low' },
      { dimension: 'world_needs', fuzzySet: 'low' },
    ],
    consequent: 0.30,
    weight: 1.0,
  },
];

export interface RawAlignment {
  love: number;
  good_at: number;
  world_needs: number;
  paid_for: number;
}

export interface RuleFiringRecord {
  ruleId: string;
  text: string;
  explanation: string;
  firing_strength: number;
  consequent: number;
  weight: number;
  contribution: number;   // weight * firing_strength * consequent
  antecedent_memberships: Array<{
    dimension: IkigaiDimension;
    fuzzySet: FuzzySet;
    membership: number;
  }>;
}

export interface RuleEvaluation {
  composite: number;
  total_firing: number;   // sum(weight * firing_strength)
  fired: RuleFiringRecord[];
  /** Rules whose firing strength was 0 — kept for full audit trail. */
  silent: Array<{ ruleId: string; text: string }>;
}

/**
 * Evaluate the rule base against the four raw dimension alignments.
 *
 * Pure function. Deterministic. The output is a full audit record — the
 * caller persists it as rule_trace.
 */
export function evaluateRules(
  raw: RawAlignment,
  rules: IkigaiRule[] = V0_RULE_BASE,
): RuleEvaluation {
  // Pre-compute the membership triple for each dimension once. This is the
  // fuzzification step.
  const memberships: Record<IkigaiDimension, Record<FuzzySet, number>> = {
    love:        membershipTriple('love',        raw.love),
    good_at:     membershipTriple('good_at',     raw.good_at),
    world_needs: membershipTriple('world_needs', raw.world_needs),
    paid_for:    membershipTriple('paid_for',    raw.paid_for),
  };

  const fired: RuleFiringRecord[] = [];
  const silent: Array<{ ruleId: string; text: string }> = [];

  let weightedConsequentSum = 0;
  let totalFiring = 0;

  for (const rule of rules) {
    // Firing strength = min() over antecedent memberships (T-norm = min).
    let firingStrength = 1;
    const antecedentRecords: RuleFiringRecord['antecedent_memberships'] = [];

    for (const a of rule.antecedents) {
      const m = memberships[a.dimension][a.fuzzySet];
      antecedentRecords.push({
        dimension: a.dimension,
        fuzzySet: a.fuzzySet,
        membership: m,
      });
      if (m < firingStrength) firingStrength = m;
    }

    if (rule.antecedents.length === 0 || firingStrength <= 0) {
      silent.push({ ruleId: rule.id, text: rule.text });
      continue;
    }

    const contribution = rule.weight * firingStrength * rule.consequent;
    weightedConsequentSum += contribution;
    totalFiring += rule.weight * firingStrength;

    fired.push({
      ruleId: rule.id,
      text: rule.text,
      explanation: rule.explanation,
      firing_strength: firingStrength,
      consequent: rule.consequent,
      weight: rule.weight,
      contribution,
      antecedent_memberships: antecedentRecords,
    });
  }

  // Sugeno defuzzification — weighted average. If nothing fires, composite is
  // 0 by convention (no opinion).
  const composite = totalFiring > 0
    ? weightedConsequentSum / totalFiring
    : 0;

  return {
    composite: clamp01(composite),
    total_firing: totalFiring,
    fired,
    silent,
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
