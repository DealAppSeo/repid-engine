/**
 * ANFIS-Ikigai v0.1 — Structured Antagonist Evaluation
 *
 * The SBFA antagonist perspective (anfis-sbfa-perspectives.ts) is one of
 * five voices. This module promotes that voice to a first-class
 * structured evaluation with explicit veto math and counter-evidence
 * extraction.
 *
 * Patent note (P-014 §3.6): the structured antagonist closes the
 * anti-engagement-economy loop at *runtime* the same way Rule 6 closes it
 * at *scoring time*. Two layers — fuzzy rule R6 catches the "engaging but
 * unproductive" pattern statically, the antagonist catches it dynamically
 * with model-based reasoning.
 *
 * Net-score math:
 *
 *     net_score = v0_composite × (1 - 0.5 × antagonist_score)
 *
 * Worked examples:
 *   v0=0.80, antagonist=0.6  → 0.80 × 0.7  = 0.56  (de-prioritised, still surfaces)
 *   v0=0.80, antagonist=0.9  → 0.80 × 0.55 = 0.44  (drops below 0.6 threshold, suppressed)
 *   v0=0.80, antagonist=0.2  → 0.80 × 0.9  = 0.72  (mild dampening only)
 *
 * Veto trigger: antagonist_score > 0.70 sets veto_triggered=true. The net
 * score is still emitted so the digest endpoint can decide whether to
 * surface as "vetoed but visible" or hide entirely.
 */

import { AttentionSignal, IkigaiProfile } from './anfis-ikigai-scorer';

export interface AntagonistEvaluation {
  argument_against: string;
  counter_evidence_keywords: string[];
  antagonist_score: number;
  protagonist_score: number;
  net_score: number;
  veto_triggered: boolean;
  /** Numeric strength category, useful in audit logs. */
  strength: 'weak' | 'moderate' | 'strong';
}

export const ANTAGONIST_VETO_THRESHOLD = 0.70;
export const ANTAGONIST_STRENGTH_THRESHOLDS = { weak: 0.30, moderate: 0.70 };

/**
 * Heuristic counter-evidence keyword extractor used when the LLM
 * antagonist couldn't articulate one. Matches a small library of
 * engagement-bait markers; v1 will train this from labelled feedback.
 */
const ENGAGEMENT_BAIT_MARKERS = [
  'hot take', 'hot takes', 'ratio', 'ratios', 'dunking', 'dunked', 'shitpost',
  'meme', 'memes', 'drama', 'flame war', 'culture war', 'clickbait',
  'going viral', 'pure entertainment', 'no insight', 'no substance',
  'in shambles', 'bloopers', 'fails', 'rant',
];

function extractCounterEvidence(content: string): string[] {
  const text = (content ?? '').toLowerCase();
  const hits = new Set<string>();
  for (const m of ENGAGEMENT_BAIT_MARKERS) {
    if (text.includes(m)) hits.add(m);
  }
  return Array.from(hits).slice(0, 8);
}

function classifyStrength(antagonistScore: number): AntagonistEvaluation['strength'] {
  if (antagonistScore < ANTAGONIST_STRENGTH_THRESHOLDS.weak) return 'weak';
  if (antagonistScore < ANTAGONIST_STRENGTH_THRESHOLDS.moderate) return 'moderate';
  return 'strong';
}

export interface EvaluateAntagonistOptions {
  /** Override the perspective rationale captured upstream. */
  rationale?: string;
}

/**
 * Evaluate the structured antagonist path. This is a synchronous compute —
 * the LLM call already happened upstream in scoreFromPerspectives() and
 * gave us perspectiveAntagonistScore. We just structure it.
 */
export function evaluateAntagonist(
  signal: AttentionSignal,
  _profile: IkigaiProfile,
  v0CompositeScore: number,
  perspectiveAntagonistScore: number,
  options: EvaluateAntagonistOptions = {},
): AntagonistEvaluation {
  const a = clamp01(perspectiveAntagonistScore);
  const v0 = clamp01(v0CompositeScore);

  const counter = extractCounterEvidence(signal.content);
  const strength = classifyStrength(a);
  const veto_triggered = a > ANTAGONIST_VETO_THRESHOLD;

  // Net-score formula. 0.5 coefficient means antagonist=1 caps the
  // dampening at half the v0 score — never zeroes out a strong v0 result.
  const net = v0 * (1 - 0.5 * a);

  const argument_against =
    options.rationale ??
    (veto_triggered
      ? `Strong veto: antagonist score ${a.toFixed(2)} exceeds threshold ${ANTAGONIST_VETO_THRESHOLD}. Counter-evidence terms: ${counter.join(', ') || 'pattern-only signal'}.`
      : strength === 'moderate'
      ? `Moderate concern: antagonist sees ${counter.length ? 'engagement-bait markers (' + counter.join(', ') + ')' : 'enough doubt'} to dampen the score.`
      : `Weak antagonist: ${counter.length ? 'no engagement-bait markers' : 'no counter-evidence'}; pass through with minor dampening.`);

  return {
    argument_against,
    counter_evidence_keywords: counter,
    antagonist_score: round4(a),
    protagonist_score: round4(v0),
    net_score: round4(net),
    veto_triggered,
    strength,
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
