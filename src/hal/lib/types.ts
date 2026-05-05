/**
 * HAL library types. The interface contract for external callers
 * (Gemini benchmarks, @hyperdag/protocol modular kernel, etc.).
 *
 * Stable since 2026-05-04. Field names are patent-load-bearing —
 * never rename without updating patent docs first.
 */

export type CommaSeverity = 'none' | 'minor' | 'major' | 'critical';

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
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
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
}

export interface ExtractInput {
  text: string;
  domain: string;
  certainty: number;
  domainOntologies?: Record<string, string[]>;
}
