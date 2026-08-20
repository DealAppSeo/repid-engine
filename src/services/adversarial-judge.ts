// Using global fetch
import { db } from '../db';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import crypto from 'crypto';

/**
 * Defect 1 fix (2026-05-18) — adversarial judge provider ROTATION.
 *
 * Replaces the prior hard-coded binary (default Anthropic; if claimer is
 * Anthropic use OpenAI). That single-attempt design returned
 * { verdict:'ESCALATE', confidence:0, critique:'Failed to parse' } whenever
 * the one chosen provider produced unparseable output or errored — with no
 * second attempt. This rotates a priority list until one provider returns a
 * real, parseable verdict with confidence > 0.
 *
 * Priority (skip any provider in the claimer's own LLM family — the point of
 * an adversarial judge is a different-family critic):
 *   1. Anthropic  claude-haiku-4-5-20251001   (PRIMARY — proven Fix #2B)
 *   2. Groq       llama-3.3-70b-versatile      (proven this run, PCP path)
 *   3. OpenAI     gpt-4o-mini                  (funded 2026-05-18)
 *   4. Gemini     gemini-2.0-flash             (if GEMINI/GOOGLE key set)
 *   5. DeepSeek   deepseek-chat                (if DEEPSEEK_API_KEY set)
 *   6. Cerebras   llama-3.3-70b                (if CEREBRAS_API_KEY set)
 *
 * RULE-11 (no silent catch on audit surfaces): every provider failure
 * is logged with its provider name AND a distinguishable failure_mode
 * (no_api_key | http_<status> | network_error | unparseable |
 * no_verdict_or_zero_confidence). If ALL providers fail, the return is a REAL
 * ESCALATE whose critique enumerates every attempt and its failure mode —
 * distinguishable from a model that genuinely said ESCALATE.
 *
 * Disclosure gate: no T-formula, no Pythagorean Comma literals, no ANFIS coeffs.
 */

const CALL_TIMEOUT_MS = parseInt(process.env.JUDGE_CALL_TIMEOUT_MS || '20000', 10);

type JudgeFamily = 'anthropic' | 'groq' | 'openai' | 'gemini' | 'deepseek' | 'cerebras';

interface ProviderSpec {
  family: JudgeFamily;
  model: string;
  apiKey: () => string | undefined;
  call: (prompt: string, model: string, apiKey: string) => Promise<{
    text: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  }>;
}

interface JudgeAttempt {
  provider: JudgeFamily;
  failure_mode:
    | 'no_api_key'
    | 'network_error'
    | 'unparseable'
    | 'no_verdict_or_zero_confidence'
    | `http_${number}`
    | 'skipped_claimer_family';
  detail?: string;
}

export interface AdversarialJudgeResult {
  verdict: string;
  confidence: number;
  critique: string;
  judge_provider: JudgeFamily | 'none';
  judge_attempts: JudgeAttempt[];
}

function withTimeout(): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

// --- OpenAI-compatible chat/completions (Groq, OpenAI, DeepSeek, Cerebras) ---
async function callOpenAICompatible(
  endpoint: string,
  prompt: string,
  model: string,
  apiKey: string
): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const { signal, clear } = withTimeout();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content || '{}',
      usage: {
        prompt_tokens: json.usage?.prompt_tokens || 0,
        completion_tokens: json.usage?.completion_tokens || 0,
      }
    };
  } finally {
    clear();
  }
}

const PROVIDERS: ProviderSpec[] = [
  {
    family: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKey: () => process.env.ANTHROPIC_API_KEY,
    call: async (prompt, model, apiKey) => {
      const { signal, clear } = withTimeout();
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 200,
            temperature: 0.1,
            system: 'You are a critical adversarial judge.',
            messages: [{ role: 'user', content: prompt }],
          }),
          signal,
        });
        if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
        const json: any = await res.json();
        return {
          text: json.content?.[0]?.text || '{}',
          usage: {
            prompt_tokens: json.usage?.input_tokens || 0,
            completion_tokens: json.usage?.output_tokens || 0,
          }
        };
      } finally {
        clear();
      }
    },
  },
  {
    family: 'groq',
    model: 'llama-3.3-70b-versatile',
    apiKey: () => process.env.GROQ_API_KEY,
    call: (p, m, k) => callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', p, m, k),
  },
  {
    family: 'openai',
    model: 'gpt-4o-mini',
    apiKey: () => process.env.OPENAI_API_KEY,
    call: (p, m, k) => callOpenAICompatible('https://api.openai.com/v1/chat/completions', p, m, k),
  },
  {
    family: 'gemini',
    model: 'gemini-2.0-flash',
    apiKey: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    call: async (prompt, model, apiKey) => {
      const { signal, clear } = withTimeout();
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
            }),
            signal,
          }
        );
        if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
        const json: any = await res.json();
        return {
          text: json.candidates?.[0]?.content?.parts?.[0]?.text || '{}',
          usage: {
            prompt_tokens: json.usageMetadata?.promptTokenCount || 0,
            completion_tokens: json.usageMetadata?.candidatesTokenCount || 0,
          }
        };
      } finally {
        clear();
      }
    },
  },
  {
    family: 'deepseek',
    model: 'deepseek-chat',
    apiKey: () => process.env.DEEPSEEK_API_KEY,
    call: (p, m, k) => callOpenAICompatible('https://api.deepseek.com/v1/chat/completions', p, m, k),
  },
  {
    family: 'cerebras',
    model: 'llama-3.3-70b',
    apiKey: () => process.env.CEREBRAS_API_KEY,
    call: (p, m, k) => callOpenAICompatible('https://api.cerebras.ai/v1/chat/completions', p, m, k),
  },
];

function claimerFamily(taskData: any): JudgeFamily | null {
  let raw = '';
  if (taskData?.metadata) {
    const meta =
      typeof taskData.metadata === 'string' ? safeParse(taskData.metadata) : taskData.metadata;
    raw = String(meta?.provider || meta?.provider_used || '').toLowerCase();
  }
  if (!raw || raw === 'unknown') return null;
  if (raw.includes('anthropic') || raw.includes('claude')) return 'anthropic';
  if (raw.includes('openai') || raw.includes('gpt')) return 'openai';
  if (raw.includes('groq')) return 'groq';
  if (raw.includes('gemini') || raw.includes('google')) return 'gemini';
  if (raw.includes('deepseek')) return 'deepseek';
  if (raw.includes('cerebras')) return 'cerebras';
  return null;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Observability: one provider_health row per rotation attempt (success |
 * failure | skipped). Best-effort — a health-write failure is logged but
 * NEVER throws, so observability can never break adversarial judging.
 * provider_health is an observability surface, not the audit/money
 * surface, so log-and-swallow is correct here (cf. RULE-11 which governs the
 * audit surfaces). View: provider_health_summary.
 */
async function recordProviderHealth(row: {
  provider: string;
  model: string;
  outcome: 'success' | 'failure' | 'skipped';
  failure_mode?: string | null;
  latency_ms?: number | null;
  task_id?: string | null;
  verdict?: string | null;
  confidence?: number | null;
}): Promise<void> {
  try {
    const { error } = await db.from('provider_health').insert({
      provider: row.provider,
      model: row.model,
      outcome: row.outcome,
      failure_mode: row.failure_mode ?? null,
      latency_ms: row.latency_ms ?? null,
      task_id: row.task_id ?? null,
      verdict: row.verdict ?? null,
      confidence: row.confidence ?? null,
      source: 'adversarial_judge',
    });
    if (error) {
      console.warn(`[AdversarialJudge] provider_health write failed (${row.provider}/${row.outcome}):`, error.message);
    }
  } catch (e: any) {
    console.warn(`[AdversarialJudge] provider_health write threw (${row.provider}/${row.outcome}):`, e?.message ?? e);
  }
}

export async function runAdversarialJudge(taskData: any): Promise<AdversarialJudgeResult> {
  const prompt = `You are a critical adversarial judge. A subordinate agent has submitted the following task response.
Your goal is to actively find flaws, hallucinations, or unfulfilled requirements.

TASK: ${taskData.title}
DESCRIPTION: ${taskData.description}
AGENT OUTPUT:
${taskData.result}

Evaluate strictly. Output a JSON object with:
- verdict: "APPROVE", "CHALLENGE", or "ESCALATE"
- confidence: 0.0 to 1.0
- critique: one sentence reasoning

Output ONLY valid JSON.`;

  const skipFamily = claimerFamily(taskData);
  const attempts: JudgeAttempt[] = [];
  const taskId = taskData?.id != null ? String(taskData.id) : null;

  for (const p of PROVIDERS) {
    if (skipFamily && p.family === skipFamily) {
      attempts.push({ provider: p.family, failure_mode: 'skipped_claimer_family' });
      await recordProviderHealth({
        provider: p.family, model: p.model, outcome: 'skipped',
        failure_mode: 'skipped_claimer_family', task_id: taskId,
      });
      continue;
    }

    const key = p.apiKey();
    if (!key) {
      attempts.push({ provider: p.family, failure_mode: 'no_api_key' });
      console.warn(`[AdversarialJudge] ${p.family}: no API key set — rotating to next provider.`);
      await recordProviderHealth({
        provider: p.family, model: p.model, outcome: 'failure',
        failure_mode: 'no_api_key', task_id: taskId,
      });
      continue;
    }

    let raw: string;
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    const call_id = crypto.randomUUID();
    const t0 = Date.now();
    try {
      const res = await p.call(prompt, p.model, key);
      raw = res.text;
      usage = res.usage;
      const latency = Date.now() - t0;
      const tokensIn = usage?.prompt_tokens || 0;
      const tokensOut = usage?.completion_tokens || 0;
      const cost_usd = calculateCost(p.family, p.model, tokensIn, tokensOut);
      
      logLlmCall({
        call_id,
        provider: p.family,
        tier: p.family === 'anthropic' || p.family === 'openai' ? '1' : '0a',
        model: p.model,
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        cost_usd,
        latency_ms: latency,
        status: 'success',
        task_hint: 'adversarial_judge'
      }).catch(err => console.error('[AdversarialJudge] logLlmCall error:', err));
    } catch (err: any) {
      const latency = Date.now() - t0;
      const mode: JudgeAttempt['failure_mode'] =
        err instanceof HttpError ? (`http_${err.status}` as const) : 'network_error';
      attempts.push({ provider: p.family, failure_mode: mode, detail: err?.message });
      console.error(
        `[AdversarialJudge] ${p.family} call failed (${mode}) — rotating:`,
        err?.message ?? err
      );
      await recordProviderHealth({
        provider: p.family, model: p.model, outcome: 'failure',
        failure_mode: mode, latency_ms: latency, task_id: taskId,
      });
      logLlmCall({
        call_id,
        provider: p.family,
        tier: p.family === 'anthropic' || p.family === 'openai' ? '1' : '0a',
        model: p.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms: latency,
        status: 'failed',
        error_message: err.message || String(err),
        task_hint: 'adversarial_judge'
      }).catch(err => console.error('[AdversarialJudge] logLlmCall error:', err));
      continue;
    }

    let parsed: any;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      attempts.push({ provider: p.family, failure_mode: 'unparseable', detail: raw.slice(0, 120) });
      console.error(`[AdversarialJudge] ${p.family}: unparseable output — rotating to next provider.`);
      await recordProviderHealth({
        provider: p.family, model: p.model, outcome: 'failure',
        failure_mode: 'unparseable', latency_ms: Date.now() - t0, task_id: taskId,
      });
      continue;
    }

    const verdict = parsed?.verdict ? String(parsed.verdict).toUpperCase() : '';
    const confidence = Number(parsed?.confidence);
    if (!verdict || !Number.isFinite(confidence) || confidence <= 0) {
      attempts.push({
        provider: p.family,
        failure_mode: 'no_verdict_or_zero_confidence',
        detail: `verdict=${verdict || 'none'} confidence=${parsed?.confidence}`,
      });
      console.error(
        `[AdversarialJudge] ${p.family}: no verdict / zero confidence — rotating to next provider.`
      );
      await recordProviderHealth({
        provider: p.family, model: p.model, outcome: 'failure',
        failure_mode: 'no_verdict_or_zero_confidence',
        latency_ms: Date.now() - t0, task_id: taskId,
      });
      continue;
    }

    console.log(
      `[AdversarialJudge] verdict from ${p.family}: ${verdict} (confidence ${confidence})`
    );
    await recordProviderHealth({
      provider: p.family, model: p.model, outcome: 'success',
      latency_ms: Date.now() - t0, task_id: taskId, verdict, confidence,
    });
    return {
      verdict,
      confidence,
      critique: parsed.critique || `${p.family} judge: no critique provided`,
      judge_provider: p.family,
      judge_attempts: attempts,
    };
  }

  // Every provider exhausted. REAL ESCALATE — the critique enumerates each
  // attempt + failure mode so this is distinguishable from a model that
  // genuinely returned ESCALATE.
  const trail = attempts.map((a) => `${a.provider}:${a.failure_mode}`).join('; ') || 'no providers attempted';
  const critique = `All adversarial providers failed: ${trail}`;
  console.error(`[AdversarialJudge] ALL providers failed. ${critique}`);
  return {
    verdict: 'ESCALATE',
    confidence: 0,
    critique,
    judge_provider: 'none',
    judge_attempts: attempts,
  };
}
