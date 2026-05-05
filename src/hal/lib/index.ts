/**
 * Public entry point for the @hyperdag/hal library (currently consumed
 * via relative-path import; Phase 6 wraps for npm publication).
 *
 * Stable surface for external callers — Gemini benchmark harness,
 * @hyperdag/protocol modular kernel, third-party integrations.
 *
 * Versioning: this is v0.1.0-alpha. Breaking changes to the exported
 * names below require coordinated updates to consumers.
 */

// Constants (always real — no stubs)
export {
  HAL_PYTHAGOREAN_COMMA,
  HAL_FORMULA_WEIGHTS,
  HAL_DEFAULT_VETO_THRESHOLD,
  HAL_CONSTITUTIONAL_BLOCK_THRESHOLD,
  COMMA_BFT_THRESHOLDS,
  DEFAULT_DOMAIN_ONTOLOGIES,
  OVERCONFIDENCE_MARKERS,
  EPISTEMIC_HEDGES,
} from './constants';

// Types
export type {
  HALSignals,
  HALResult,
  HALContext,
  HALProviderConfig,
  HALEmbeddingClient,
  CommaSeverity,
  CrossLLMSummary,
  ExtractInput,
  StrictnessLevel,
  AgreementZone,
  HALTamperingSignal,
} from './types';

// Score (real, no stub)
export { computeHALScore } from './score';
export type { HALScoreOutput } from './score';

// Extract (Phase 3 stub)
export { extractHALSignals } from './extract';

// Classifier (Phase 4 stub)
export { classify } from './classifier';
export type { Category, Confidence, ClassificationResult, ClassifyOptions } from './classifier';

// Cross-LLM (Phase 4 stub)
export { checkCrossLLM } from './cross-llm';
export type { CrossLLMOptions } from './cross-llm';

// Top-level evaluate
export { evaluate, DEFAULT_STRICTNESS } from './evaluate';
