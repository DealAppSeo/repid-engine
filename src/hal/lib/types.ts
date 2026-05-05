/**
 * HAL library types. The interface contract for external callers
 * (Gemini benchmarks, @hyperdag/protocol modular kernel, etc.).
 *
 * Stable since 2026-05-04. Field names are patent-load-bearing —
 * never rename without updating patent docs first.
 */

export type CommaSeverity = 'none' | 'minor' | 'major' | 'critical';

/**
 * Strictness level. Default is 4 (product MVP gate — what users would
 * expect to be caught is caught out of the box).
 *
 *   1 — Fast: extractor only, no cross-LLM. Drafts/brainstorms.
 *   2 — Light: cross-LLM with loose threshold. Internal docs.
 *   3 — Balanced: current production behavior (gap-based COMMA_BFT).
 *       Byte-identical to pre-Wave-5 production HAL.
 *   4 — Strict (DEFAULT): adds three-zone band classification AND
 *       consensus-vs-claim semantic comparison. Catches HAL-T1-003 class
 *       fabrications. Customer-facing/professional use.
 *   5 — Maximum: adds tampering-suspected flag when consensus collapses
 *       too tightly. Legal/medical/financial.
 */
export type StrictnessLevel = 1 | 2 | 3 | 4 | 5;

/** Three-zone classification of cross-LLM agreement around the Pythagorean Comma. */
export type AgreementZone = 'too-tight' | 'in-band' | 'too-loose';

/**
 * Tampering signal — populated only at strictness level 5 when the
 * consensus zone is 'too-tight' (suspiciously perfect agreement). Does
 * NOT auto-veto in this version; it's an informational flag for human
 * review or downstream policy.
 */
export interface HALTamperingSignal {
  similarity: number;
  responses: string[];
  reason: string;
}

export interface HALSignals {
  harm_probability: number;       // [0, 1] — higher = riskier
  epistemic_uncertainty: number;  // [0, 1] — higher = more mismatch
  evidence_quality: number;       // [0, 1] — higher = better quality (caller inverts to risk)
  scope_appropriateness: number;  // [0, 1] — higher = better fit (caller inverts to risk)
  certainty_at_claim: number;     // [0, 1] — pass-through of caller-supplied certainty
  agreement_score?: number | null;          // Layer 1 — null when not factual/time-sensitive
  prompt_category?: string | null;          // Layer 0 classifier output
  comma_veto?: boolean | null;              // Pythagorean Comma BFT — true iff severity='critical'
  comma_gap?: number | null;                // max(beliefs) - min(beliefs); null when <3 providers
  comma_severity?: CommaSeverity | null;
}

export interface HALResult {
  signals: HALSignals;
  hal_score: number;
  vetoed: boolean;
  threshold: number;
  formula: string;
  /** Optional cross-LLM consensus output, present iff context.providers was non-empty. */
  cross_llm?: CrossLLMSummary | null;
  /** Strictness level used for this evaluation. */
  strictness: StrictnessLevel;
  /** Three-zone classification of agreement (level 4+ only; null otherwise). */
  agreement_zone?: AgreementZone | null;
  /** Aggregated consensus answer (level 4+ when in-band; null otherwise). */
  consensus_answer?: string | null;
  /** Cosine similarity of user claim vs consensus answer (level 4+; null otherwise). */
  claim_vs_consensus_similarity?: number | null;
  /** True when claim contradicts consensus (level 4+; null otherwise). */
  claim_contradicts_consensus?: boolean | null;
  /** Tampering signal — populated only at level 5 when zone='too-tight'. */
  tampering_suspected?: boolean | null;
  tampering_signal?: HALTamperingSignal | null;
}

export interface CrossLLMSummary {
  agreement_score: number;
  beliefs: number[];
  comma_severity: CommaSeverity;
  comma_gap: number | null;
  comma_veto: boolean;
  methodology: 'embedding-cosine' | 'fallback-jaccard';
  answers_per_provider: Array<{
    provider: string;
    model: string;
    answer: string;
    latency_ms: number;
    error?: string;
  }>;
}

/** A single LLM provider available to the cross-LLM consensus layer. */
export interface HALProviderConfig {
  /** Free-form provider id, e.g. "groq", "anthropic", "deepseek". */
  provider: string;
  /** Optional cross-family squad label for BFT diversity tracking. */
  squad?: 'alpha' | 'beta' | 'gamma' | string;
  /** Provider's model id (e.g. "llama-3.3-70b-versatile"). */
  model: string;
  /** Inference endpoint URL. */
  endpoint: string;
  /** API key — caller's responsibility to fetch from secrets manager. */
  apiKey: string;
  /** "openai-compat" for OpenAI-shape chat-completions; "anthropic-native" for the Anthropic Messages API. */
  callType: 'openai-compat' | 'anthropic-native';
  /** Per-provider request timeout in ms. Defaults to 10_000. */
  timeoutMs?: number;
}

/**
 * Embedding client — used by cross-LLM consensus to compute pairwise
 * similarity between provider answers. If null, falls back to Jaccard.
 */
export interface HALEmbeddingClient {
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

/**
 * Top-level evaluate() context. Everything is optional except `domain`
 * and `certainty` which the extractor reads.
 *
 * - `providers`: cross-LLM consensus runs only when this has ≥1 entry.
 * - `classifierProvider`: optional Layer 0 classifier provider. When set
 *   AND `prompt` is set, evaluate() classifies the prompt first and
 *   only runs cross-LLM for categories ∈ {factual, time-sensitive}.
 *   When omitted, cross-LLM runs unconditionally if `providers` + `prompt`.
 * - `embeddingClient`: required for embedding-cosine similarity; without
 *   it, agreement falls back to Jaccard token overlap.
 * - `supabase`: opt-in logging. null/undefined ⇒ library is silent.
 * - `threshold`: overrides HAL_DEFAULT_VETO_THRESHOLD (0.25).
 * - `domainOntologies`: extra domains beyond the 5 baked-in ones.
 * - `strictness`: 1-5 scale. Default 4. See StrictnessLevel docs.
 */
export interface HALContext {
  domain: string;
  certainty: number;
  prompt?: string;
  providers?: HALProviderConfig[];
  classifierProvider?: HALProviderConfig | null;
  embeddingClient?: HALEmbeddingClient | null;
  supabase?: unknown | null; // typed as `unknown` to avoid coupling to @supabase/supabase-js in this file
  threshold?: number;
  domainOntologies?: Record<string, string[]>;
  strictness?: StrictnessLevel;
  commaOverride?: number;
}

export interface ExtractInput {
  text: string;
  domain: string;
  certainty: number;
  domainOntologies?: Record<string, string[]>;
}
