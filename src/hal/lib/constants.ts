/**
 * HAL constants — centralized, dependency-free.
 *
 * Patent-load-bearing: HAL_PYTHAGOREAN_COMMA preserves the exact ratio
 * 531441/524288. The decimal approximation 1.0136433 is informational
 * only — never substitute the decimal for the ratio in computation.
 * (Sprint hard rule #15.)
 *
 * Signal field names (HALSignals.harm_probability etc.) and the canonical
 * formula weights are also patent-load-bearing — see
 * docs/HAL_LIBRARY_API.md and docs/HAL_CANONICAL_v1.md.
 */

export const HAL_PYTHAGOREAN_COMMA: number = 531441 / 524288;

/**
 * Canonical hal_score formula coefficients (Path A).
 *   hal_score = (
 *     w_harm * harm_probability
 *   + w_epistemic * epistemic_uncertainty
 *   + w_evidence * (1 - evidence_quality)
 *   + w_scope * (1 - scope_appropriateness)
 *   ) * HAL_PYTHAGOREAN_COMMA
 */
export const HAL_FORMULA_WEIGHTS = {
  harm: 0.4,
  epistemic: 0.3,
  evidence: 0.2,
  scope: 0.1,
} as const;

/** Default veto threshold when caller does not override (matches `runValidation` demo and existing /score-event halApproveThreshold default). */
export const HAL_DEFAULT_VETO_THRESHOLD: number = 0.25;

/** Constitutional block threshold — hard 403 in production scoring path. */
export const HAL_CONSTITUTIONAL_BLOCK_THRESHOLD: number = 0.48;

/**
 * Pythagorean Comma BFT severity tier thresholds (P-003).
 * Ported verbatim from src/hal/cross-llm-client.ts:65-69 — DO NOT TUNE.
 */
export const COMMA_BFT_THRESHOLDS = {
  vetoGap: 0.05,
  vetoAvg: 0.85,
  majorGap: 0.10,
  majorAvg: 0.75,
  minorGap: 0.15,
} as const;

/**
 * Wave 5 — Pythagorean Comma BAND classification (level 4+).
 *
 * The Pythagorean Comma defines the principled CENTER of the agreement
 * band. Agreement TIGHTER than the band = suspicious (potential
 * tampering / training-data contamination). Agreement WITHIN the band
 * = trusted consensus. Agreement LOOSER than the band = uncertainty.
 *
 * Initial calibration (refined by federated learning, v0.2-0.3):
 *   - Comma value: 1.0136433 (531441/524288, sacred — never modify)
 *   - Normalized to similarity scale: ~0.987 (1 / 1.0136433)
 *   - Band width: ±0.05 around the comma normalized value
 *   - Too-tight zone:  similarity > 0.99  (suspiciously perfect)
 *   - In-band zone:    0.95 < similarity ≤ 0.99  (trusted consensus)
 *   - Too-loose zone:  similarity ≤ 0.95  (uncertainty)
 *
 * These zone boundaries are calibratable. The Pythagorean Comma
 * constant itself is fixed (patent-load-bearing, hard-rule #2).
 */
export const COMMA_BAND_TIGHT_THRESHOLD: number = 0.99;
export const COMMA_BAND_LOOSE_THRESHOLD: number = 0.95;

/**
 * Domain ontology vocabularies. High-level definition only — caller can
 * supply additional/custom ontologies via context.
 */
export const DEFAULT_DOMAIN_ONTOLOGIES: Record<string, string[]> = {
  'cre-underwriting': [
    'cap rate', 'noi', 'vacancy', 'absorption', 'ltv', 'dscr', 'irr',
    'cash-on-cash', 'basis points', 'underwriting', 'class a', 'class b',
    'industrial', 'office', 'retail', 'multifamily', 'operating expenses',
    'gross rent', 'debt service', 'net operating income',
  ],
  'compliance': [
    'regulation', 'statute', 'compliance', 'audit', 'disclosure', 'fiduciary',
    'sec', 'finra', 'gdpr', 'ccpa', 'ai act', 'liability', 'mandate',
    'enforcement', 'violation', 'risk management', 'governance',
  ],
  'finance': [
    'revenue', 'ebitda', 'margin', 'yield', 'return', 'risk', 'portfolio',
    'asset', 'liability', 'equity', 'debt', 'interest rate', 'inflation',
    'basis', 'spread', 'valuation', 'cash flow', 'projection',
  ],
  'technical': [
    'algorithm', 'model', 'training', 'inference', 'parameter', 'neural',
    'circuit', 'hash', 'proof', 'contract', 'token', 'consensus',
    'validation', 'cryptography', 'protocol', 'architecture', 'implementation',
  ],
  'legal': [
    'contract', 'clause', 'covenant', 'warranty', 'indemnification', 'lien',
    'title', 'easement', 'encumbrance', 'jurisdiction', 'statute', 'precedent',
  ],
};

export const OVERCONFIDENCE_MARKERS: readonly string[] = [
  'guaranteed', 'certain', 'definitive', 'proven', 'fact',
  'always', 'never', 'impossible', 'must', 'will definitely',
  'risk-free', 'no risk', '100%', 'without doubt',
  'everyone knows', 'obviously', 'clearly', 'undeniably',
];

/**
 * Note the duplicate `approximately` at index 0 and again at the tail.
 * This is preserved verbatim from the pre-extraction implementation
 * (`src/services/hal-signals.ts:52-57` at HEAD `204cfcb`). The duplicate
 * causes texts containing "approximately" to count twice toward hedge
 * density. Per sprint hard rule #7 (no semantic changes to HAL behavior),
 * this is preserved as-is. Parking-lot item: decide whether to dedupe
 * intentionally in a future tuning sprint.
 */
export const EPISTEMIC_HEDGES: readonly string[] = [
  'approximately', 'roughly', 'around', 'may', 'might', 'could',
  'likely', 'probably', 'suggest', 'indicate', 'appear', 'seem',
  'estimate', 'projection', 'forecast', 'assumption', 'according to',
  'based on', 'as of', 'reported', 'approximately',
];
