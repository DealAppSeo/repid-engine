/**
 * Cross-LLM consensus + Pythagorean Comma BFT — public entry point.
 *
 * Ported from src/hal/cross-llm-client.ts:454-533. Contract preserved:
 * 3 providers per call (typical), beliefs derived from pairwise textual
 * agreement, BFT veto when severity === 'critical'. The HTTP-proxy mode
 * (CROSS_LLM_VERIFIER_URL) is NOT included here — the lib is for callers
 * that bring their own provider list. The legacy services/cross-llm-client.ts
 * wrapper retains the HTTP proxy path for production trinity-ecosystem use.
 *
 * Persistence is opt-in via `supabase` parameter. When null/undefined,
 * the library never writes to a DB.
 */
import crypto from 'crypto';
import type { CommaSeverity, CrossLLMSummary, HALEmbeddingClient, HALProviderConfig } from '../types';
import { computeAgreement, checkPythagoreanComma } from './agreement';
import { queryProvider, type ProviderAnswer } from './providers';

export interface CrossLLMOptions {
  providers: HALProviderConfig[];
  embeddingClient?: HALEmbeddingClient | null;
  /**
   * Supabase client. `null`/`undefined` ⇒ no persistence.
   * Typed as `unknown` to avoid coupling on the @supabase/supabase-js
   * package in this header. Internal duck-types `.from(table).insert(row)`.
   */
  supabase?: unknown | null;
  /** Per-provider request timeout. Default 10_000 ms. */
  timeoutMs?: number;
  /** Default true — set false to skip Supabase writes even when supabase is provided. */
  persist?: boolean;
  commaOverride?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

async function persistComparison(
  supabase: any, promptHash: string, r: CrossLLMSummary, latencyMs: number,
): Promise<void> {
  if (!supabase || typeof supabase.from !== 'function') return;
  try {
    await supabase.from('cross_llm_comparisons').insert({
      prompt_hash: promptHash,
      provider_1: r.answers_per_provider[0]?.provider ?? null,
      provider_2: r.answers_per_provider[1]?.provider ?? null,
      model_1: r.answers_per_provider[0]?.model ?? null,
      model_2: r.answers_per_provider[1]?.model ?? null,
      answer_1_preview: (r.answers_per_provider[0]?.answer ?? '').slice(0, 500),
      answer_2_preview: (r.answers_per_provider[1]?.answer ?? '').slice(0, 500),
      agreement_score: r.agreement_score,
      embedding_distance: 1 - r.agreement_score,
      methodology: r.methodology,
      latency_ms: latencyMs,
      provider_responses: r.answers_per_provider.map(a => ({
        provider: a.provider,
        model: a.model,
        answer_preview: (a.answer ?? '').slice(0, 500),
        latency_ms: a.latency_ms,
        error: a.error ?? null,
      })),
      provider_count: r.answers_per_provider.filter(a => !a.error && a.answer).length,
      comma_veto: r.comma_veto,
      comma_gap: r.comma_gap,
      comma_severity: r.comma_severity,
    });
  } catch (e: any) {
    console.error('[hal/lib/cross-llm] persist failed:', e?.message ?? e);
  }
}

/**
 * Run cross-LLM consensus + Pythagorean Comma BFT.
 *
 * Returns a CrossLLMSummary even when 0–1 providers respond (degenerate
 * case): agreement_score=0, comma_severity='none', beliefs=[]. Callers
 * should treat low provider counts as "no signal" rather than "agreement."
 */
export async function checkCrossLLM(
  prompt: string,
  options: CrossLLMOptions,
): Promise<CrossLLMSummary> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const providersWithTimeout: HALProviderConfig[] = options.providers.map(p => ({
    ...p,
    timeoutMs: p.timeoutMs ?? timeoutMs,
  }));

  const settled = await Promise.allSettled(
    providersWithTimeout.map(cfg => queryProvider(cfg, prompt)),
  );
  const answers: ProviderAnswer[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      provider: providersWithTimeout[i]!.provider,
      squad: providersWithTimeout[i]!.squad ?? 'alpha',
      model: providersWithTimeout[i]!.model,
      answer: '',
      latency_ms: 0,
      error: String((s as PromiseRejectedResult).reason),
    };
  });

  const answered = answers
    .map((a, i) => ({ idx: i, text: a.answer ?? '', error: a.error }))
    .filter(x => !x.error && x.text.trim().length > 0)
    .map(x => ({ idx: x.idx, text: x.text }));

  if (answered.length < 2) {
    const result: CrossLLMSummary = {
      agreement_score: 0,
      beliefs: [],
      comma_severity: 'none' as CommaSeverity,
      comma_gap: null,
      comma_veto: false,
      methodology: 'fallback-jaccard',
      answers_per_provider: answers,
    };
    if (options.persist !== false && options.supabase) {
      void persistComparison(options.supabase, hashPrompt(prompt), result, Date.now() - start);
    }
    return result;
  }

  const { beliefs, meanAgreement, methodology } = await computeAgreement(
    answered, options.embeddingClient,
  );
  const { severity, comma_gap, comma_veto } = checkPythagoreanComma(beliefs, options.commaOverride);

  const agreement_score = Math.max(0, Math.min(1, meanAgreement));
  const result: CrossLLMSummary = {
    agreement_score: Number(agreement_score.toFixed(4)),
    beliefs: beliefs.map(b => Number(b.toFixed(4))),
    comma_severity: severity,
    comma_gap: comma_gap === null ? null : Number(comma_gap.toFixed(4)),
    comma_veto,
    methodology,
    answers_per_provider: answers,
  };

  if (options.persist !== false && options.supabase) {
    void persistComparison(options.supabase, hashPrompt(prompt), result, Date.now() - start);
  }
  return result;
}

// Re-export pure helpers so consumers can compose without importing internals.
export { computeAgreement, checkPythagoreanComma, cosineSimilarity, jaccardSimilarity } from './agreement';
export type { ProviderAnswer } from './providers';
