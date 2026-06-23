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
import { pgQuery } from '../../../db/direct-pg';

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

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}
const circuitStates: Record<string, CircuitState> = {};

function getCircuitState(provider: string): CircuitState {
  const norm = provider.toLowerCase().trim();
  if (!circuitStates[norm]) {
    circuitStates[norm] = { consecutiveFailures: 0, openUntil: 0 };
  }
  return circuitStates[norm]!;
}

export function isCircuitOpen(provider: string): boolean {
  const state = getCircuitState(provider);
  return Date.now() < state.openUntil;
}

async function setProviderHealth(providerName: string, verified: boolean): Promise<void> {
  try {
    let mappedName = providerName.toLowerCase().trim();
    if (mappedName === 'anthropic') {
      mappedName = 'anthropic-direct';
    }
    const rows = await pgQuery(
      'SELECT id FROM provider_trust_scores WHERE provider_name = $1',
      [mappedName]
    );
    if (rows.length > 0) {
      await pgQuery(
        'UPDATE provider_trust_scores SET verified = $2, last_updated = NOW() WHERE provider_name = $1',
        [mappedName, verified]
      );
    } else {
      await pgQuery(
        'INSERT INTO provider_trust_scores (provider_name, verified, last_updated) VALUES ($1, $2, NOW())',
        [mappedName, verified]
      );
    }
    console.log(`[setProviderHealth] updated health of ${mappedName} in DB to ${verified}`);
  } catch (err: any) {
    console.error(`[setProviderHealth] failed for ${providerName}:`, err.message || err);
  }
}

export async function markProviderSuccess(provider: string): Promise<void> {
  const state = getCircuitState(provider);
  const wasOpen = state.consecutiveFailures >= 5;
  state.consecutiveFailures = 0;
  state.openUntil = 0;
  if (wasOpen) {
    console.log(`[circuit-breaker] CIRCUIT CLOSED (RESET) for ${provider}`);
    await setProviderHealth(provider, true);
  }
}

export async function markProviderFailure(provider: string, errMessage: string): Promise<void> {
  const state = getCircuitState(provider);
  state.consecutiveFailures += 1;
  console.warn(`[circuit-breaker] Provider ${provider} failure ${state.consecutiveFailures}/5: ${errMessage}`);
  if (state.consecutiveFailures >= 5) {
    state.openUntil = Date.now() + 5 * 60 * 1000; // 5-minute cool-down
    console.error(`[circuit-breaker] CIRCUIT OPEN for ${provider} until ${new Date(state.openUntil).toISOString()}`);
    await setProviderHealth(provider, false);
  }
}

function resolveSingleFallback(excludeNames: string[]): HALProviderConfig | null {
  const pool: HALProviderConfig[] = [
    {
      provider: 'groq',
      model: process.env.CROSS_LLM_PROVIDER_1_MODEL ?? 'llama-3.3-70b-versatile',
      endpoint: process.env.CROSS_LLM_PROVIDER_1_ENDPOINT ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY ?? '',
      callType: 'openai-compat' as const,
    },
    {
      provider: 'cerebras',
      model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'zai-glm-4.7',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: process.env.CEREBRAS_API_KEY ?? '',
      callType: 'openai-compat' as const,
    },
    {
      provider: 'fireworks',
      model: process.env.HAL_S2_FIREWORKS_MODEL ?? 'accounts/fireworks/models/kimi-k2p5',
      endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
      apiKey: process.env.FIREWORKS_API_KEY ?? '',
      callType: 'openai-compat' as const,
    },
    {
      provider: 'deepseek',
      model: process.env.CROSS_LLM_PROVIDER_3_MODEL ?? 'deepseek-chat',
      endpoint: process.env.CROSS_LLM_PROVIDER_3_ENDPOINT ?? 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      callType: 'openai-compat' as const,
    },
    {
      provider: 'anthropic',
      model: process.env.CROSS_LLM_PROVIDER_2_MODEL ?? 'claude-haiku-4-5-20251001',
      endpoint: process.env.CROSS_LLM_PROVIDER_2_ENDPOINT ?? 'https://api.anthropic.com/v1/messages',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      callType: 'anthropic-native' as const,
    }
  ];

  const excludes = new Set(excludeNames.map(n => n.toLowerCase().trim()));
  for (const p of pool) {
    if (p.apiKey && !isCircuitOpen(p.provider) && !excludes.has(p.provider.toLowerCase().trim())) {
      return p;
    }
  }
  return null;
}

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

  const selectedProviders: HALProviderConfig[] = [];
  const selectedNames = new Set<string>();

  for (const p of options.providers) {
    if (p.apiKey && !isCircuitOpen(p.provider) && !selectedNames.has(p.provider.toLowerCase().trim())) {
      selectedProviders.push({ ...p, timeoutMs: p.timeoutMs ?? timeoutMs });
      selectedNames.add(p.provider.toLowerCase().trim());
    } else {
      const fb = resolveSingleFallback([p.provider, ...selectedNames]);
      if (fb) {
        selectedProviders.push({ ...fb, squad: p.squad, timeoutMs: fb.timeoutMs ?? timeoutMs });
        selectedNames.add(fb.provider.toLowerCase().trim());
      } else {
        selectedProviders.push({ ...p, timeoutMs: p.timeoutMs ?? timeoutMs });
        selectedNames.add(p.provider.toLowerCase().trim());
      }
    }
  }

  console.log(`[checkCrossLLM] Calling ${selectedProviders.length} providers: ${selectedProviders.map((p) => p.provider).join(', ')} for prompt: "${prompt.slice(0, 60)}..."`);
  const settled = await Promise.allSettled(
    selectedProviders.map(async (cfg) => {
      try {
        const res = await queryProvider(cfg, prompt);
        if (res.error) {
          await markProviderFailure(cfg.provider, res.error);
        } else {
          await markProviderSuccess(cfg.provider);
        }
        return res;
      } catch (err: any) {
        await markProviderFailure(cfg.provider, err.message || String(err));
        throw err;
      }
    })
  );

  const answers: ProviderAnswer[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      provider: selectedProviders[i]!.provider,
      squad: String(selectedProviders[i]!.squad ?? 'alpha'),
      model: selectedProviders[i]!.model,
      answer: '',
      latency_ms: 0,
      error: String((s as PromiseRejectedResult).reason),
    };
  });

  answers.forEach(a => {
    if (a.error) {
      console.log(`  - Provider ${a.provider} FAILED in ${a.latency_ms}ms: ${a.error}`);
    } else {
      console.log(`  - Provider ${a.provider} returned answer (length ${a.answer.length}) in ${a.latency_ms}ms`);
    }
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
