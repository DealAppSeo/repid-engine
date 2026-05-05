/**
 * Path A 5-signal HAL extractor — pure, deterministic, no I/O.
 *
 * Ported from src/services/hal-signals.ts:79-151 with no semantic change.
 * Sprint hard rules #7 and #8 forbid behavior tuning here; the regression
 * test (tests/hal-regression.test.ts, 369 assertions) holds the line.
 *
 * The math:
 *   harm_probability        — overconfidence × specific-numbers, plus a 0.2
 *                             bump when certainty>0.92 and overconfidence>0
 *   epistemic_uncertainty   — 0.45 baseline minus 0.25*hedgeDensity, plus a
 *                             0.35 mismatch when certainty>0.88 and zero hedges.
 *                             For domain ∈ {mathematics, cryptography} the
 *                             mismatch is scaled to 30%, then the WHOLE result
 *                             is dampened to 15% (math/crypto formulas tend
 *                             toward overstated certainty being correct)
 *   evidence_quality        — boolean features (numbers, temporal, proper
 *                             nouns) + length score
 *   scope_appropriateness   — Jaccard-like overlap with domain ontology
 *   certainty_at_claim      — pass-through of caller-supplied certainty
 *
 * Domain fallback: unknown domain ⇒ uses 'finance' ontology.
 *
 * Caller may inject custom ontologies via input.domainOntologies, which is
 * merged on top of DEFAULT_DOMAIN_ONTOLOGIES (caller-supplied wins).
 */
import {
  DEFAULT_DOMAIN_ONTOLOGIES,
  EPISTEMIC_HEDGES,
  OVERCONFIDENCE_MARKERS,
} from './constants';
import type { ExtractInput, HALSignals } from './types';

export function extractHALSignals(input: ExtractInput): HALSignals {
  const { text: claimText, domain, certainty } = input;
  const ontologies = input.domainOntologies
    ? { ...DEFAULT_DOMAIN_ONTOLOGIES, ...input.domainOntologies }
    : DEFAULT_DOMAIN_ONTOLOGIES;

  const text = claimText.toLowerCase();
  const words = text.split(/\s+/);
  const wordCount = words.length;

  // Signal 1: harm_probability
  // Overconfident specific claims carry higher harm risk.
  const overconfidenceCount = OVERCONFIDENCE_MARKERS
    .filter(k => text.includes(k)).length;
  const specificNumbers = (
    text.match(/\d+\.?\d*\s*(%|percent|basis|bps|billion|million)/g) || []
  ).length;
  const harm_probability = Math.min(
    1,
    (overconfidenceCount * 0.18) +
    (specificNumbers * 0.08) +
    (certainty > 0.92 && overconfidenceCount > 0 ? 0.2 : 0),
  );

  // Signal 2: epistemic_uncertainty
  // Mismatch between stated certainty and expressed hedging.
  const hedgeCount = EPISTEMIC_HEDGES
    .filter(k => text.includes(k)).length;
  const hedgeDensity = hedgeCount / Math.max(wordCount / 8, 1);
  let certaintyHedgeMismatch =
    certainty > 0.88 && hedgeCount === 0 ? 0.35 : 0;

  if (domain === 'mathematics' || domain === 'cryptography') {
    certaintyHedgeMismatch *= 0.30;
  }

  let epistemic_uncertainty = Math.min(
    1,
    Math.max(0, 0.45 - (hedgeDensity * 0.25) + certaintyHedgeMismatch),
  );

  if (domain === 'mathematics' || domain === 'cryptography') {
    epistemic_uncertainty *= 0.15;
  }

  // Signal 3: evidence_quality
  const hasNumbers = /\d+/.test(text);
  const hasTemporalRef = /\b(20\d\d|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text);
  const hasProperNouns = /\b[A-Z][a-z]{2,}(\s[A-Z][a-z]{2,})+/.test(claimText);
  const lengthScore = Math.min(1, wordCount / 40);
  const evidence_quality = Math.min(
    1,
    (hasNumbers ? 0.25 : 0) +
    (hasTemporalRef ? 0.20 : 0) +
    (hasProperNouns ? 0.15 : 0) +
    (lengthScore * 0.40),
  );

  // Signal 4: scope_appropriateness — Jaccard-like overlap with domain ontology.
  const ontology = ontologies[domain] ?? ontologies['finance'] ?? [];
  const matchCount = ontology
    .filter(term => text.includes(term.toLowerCase())).length;
  const scope_appropriateness = Math.min(
    1,
    matchCount / Math.max(ontology.length * 0.25, 1),
  );

  return {
    harm_probability,
    epistemic_uncertainty,
    evidence_quality,
    scope_appropriateness,
    certainty_at_claim: certainty,
  };
}
