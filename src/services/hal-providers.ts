/**
 * HAL v2 — shared provider adapters for tiered cross-model consensus.
 *
 * Each `callModel()` call returns a uniform shape regardless of provider so
 * tier services can iterate over a heterogeneous model list without caring
 * which SDK / endpoint serves which entry.
 *
 * If a provider's API key is missing, `callModel` returns
 * { ok: false, error: 'no_api_key', ... } rather than throwing — the tier
 * is then responsible for treating that response as a missing vote, not a
 * crash. This is the "graceful degradation" behaviour required by the
 * sprint spec.
 *
 * MOCK MODE: set HAL_V2_MOCK=1 to bypass real APIs entirely. The mock
 * returns deterministic responses based on the input claim, so the
 * orchestrator + classifier + escalation logic can be benchmarked
 * end-to-end without provider keys.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'fireworks';

export interface ModelSpec {
  provider: ProviderId;
  model: string;        // model id passed to the provider
  display_name: string; // for logs / audit trail
  cost_per_million_in_usd?: number;
  cost_per_million_out_usd?: number;
}

export interface ModelCallResult {
  ok: boolean;
  answer: string;          // empty when !ok
  raw_response?: unknown;  // provider-specific raw payload (small)
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_estimate_usd: number;
  error?: string;
  model: string;
  provider: ProviderId;
}

const MOCK_MODE = process.env.HAL_V2_MOCK === '1';

export function isMockMode(): boolean {
  return MOCK_MODE;
}

export function providerKeyAvailable(provider: ProviderId): boolean {
  if (MOCK_MODE) return true;
  switch (provider) {
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':    return !!process.env.OPENAI_API_KEY;
    case 'google':    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    case 'groq':      return !!process.env.GROQ_API_KEY;
    case 'cerebras':  return !!process.env.CEREBRAS_API_KEY;
    case 'fireworks': return !!process.env.FIREWORKS_API_KEY;
  }
}

export function availableProviders(): ProviderId[] {
  const all: ProviderId[] = ['anthropic', 'openai', 'google', 'groq', 'cerebras', 'fireworks'];
  return all.filter(providerKeyAvailable);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function estimateCost(spec: ModelSpec, tokensIn: number, tokensOut: number): number {
  const inCost = (spec.cost_per_million_in_usd ?? 0.5) * tokensIn / 1_000_000;
  const outCost = (spec.cost_per_million_out_usd ?? 1.5) * tokensOut / 1_000_000;
  return inCost + outCost;
}

/**
 * Deterministic mock — for orchestrator validation when no API keys are set.
 *
 * The mock derives an "answer" from the claim by simple heuristics so the
 * consensus / escalation logic gets exercised. Per-model variation is added
 * by hashing the model name into a small offset, so a 3-model parallel call
 * produces some agreement and some disagreement, depending on the claim.
 */
function mockCall(spec: ModelSpec, prompt: string, claim: string): ModelCallResult {
  const seed = (spec.model + claim).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const lower = claim.toLowerCase();

  // Recognise obvious truths and obvious falsehoods by surface markers in
  // our 40-prompt benchmark. The mock isn't a real classifier; it just lets
  // the orchestrator's escalation/consensus paths fire deterministically.
  const obvFalse = /(capital of france is london|capital of japan is beijing|earth is flat|sun orbits the earth|water boils at 50|2 \+ 2 = 5|moon is made of cheese|einstein invented the telephone|great wall of china is visible from mars|napoleon won waterloo)/i.test(claim);
  const obvTrue = /(capital of france is paris|capital of japan is tokyo|earth orbits the sun|water boils at 100|2 \+ 2 = 4|speed of light|h2o|einstein|mount everest|pacific ocean)/i.test(claim);
  const opinion = /(best|favourite|favorite|most beautiful|prettier|tastier|should we|in my opinion|i think)/i.test(claim);

  let answer: string;
  if (opinion) {
    // Opinion queries — every model returns UNCERTAIN, no consensus on a fact
    answer = 'UNCERTAIN. Subjective question; no factual answer.';
  } else if (obvFalse) {
    // Different models all should agree the claim is INCORRECT
    answer = 'INCORRECT. The claim contradicts well-known fact.';
  } else if (obvTrue) {
    answer = 'CORRECT. The claim matches well-known fact.';
  } else {
    // Ambiguous → spread between INCORRECT/UNCERTAIN/CORRECT based on seed
    const r = seed % 3;
    answer = r === 0
      ? 'CORRECT. Plausible.'
      : r === 1
      ? 'INCORRECT. Unverified.'
      : 'UNCERTAIN. Cannot confirm without additional context.';
  }

  const tokensIn = Math.ceil(prompt.length / 4);
  const tokensOut = Math.ceil(answer.length / 4);
  return {
    ok: true,
    answer,
    latency_ms: 50 + (seed % 200),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate_usd: estimateCost(spec, tokensIn, tokensOut),
    model: spec.model,
    provider: spec.provider,
  };
}

export async function callModel(
  spec: ModelSpec,
  prompt: string,
  claim: string,
  timeoutMs: number = 5000,
): Promise<ModelCallResult> {
  const start = Date.now();
  const baseFail = (error: string): ModelCallResult => ({
    ok: false,
    answer: '',
    latency_ms: Date.now() - start,
    cost_estimate_usd: 0,
    error,
    model: spec.model,
    provider: spec.provider,
  });

  if (MOCK_MODE) {
    return mockCall(spec, prompt, claim);
  }

  if (!providerKeyAvailable(spec.provider)) {
    return baseFail('no_api_key');
  }

  try {
    let answer = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (spec.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      const r: any = await withTimeout(
        client.messages.create({
          model: spec.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }) as any,
        timeoutMs, spec.model);
      answer = r.content?.[0]?.text ?? '';
      tokensIn = r.usage?.input_tokens ?? 0;
      tokensOut = r.usage?.output_tokens ?? 0;
    } else if (spec.provider === 'google') {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!;
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({ model: spec.model });
      const r: any = await withTimeout(model.generateContent(prompt) as any, timeoutMs, spec.model);
      answer = r.response.text();
      tokensIn = r.response.usageMetadata?.promptTokenCount ?? 0;
      tokensOut = r.response.usageMetadata?.candidatesTokenCount ?? 0;
    } else {
      // OpenAI-compatible: openai, groq, cerebras, fireworks
      const baseURL =
        spec.provider === 'openai'    ? undefined :
        spec.provider === 'groq'      ? 'https://api.groq.com/openai/v1' :
        spec.provider === 'cerebras'  ? 'https://api.cerebras.ai/v1' :
        spec.provider === 'fireworks' ? 'https://api.fireworks.ai/inference/v1' :
        undefined;
      const apiKey =
        spec.provider === 'openai'    ? process.env.OPENAI_API_KEY! :
        spec.provider === 'groq'      ? process.env.GROQ_API_KEY! :
        spec.provider === 'cerebras'  ? process.env.CEREBRAS_API_KEY! :
        process.env.FIREWORKS_API_KEY!;
      const client = new OpenAI({ apiKey, baseURL });
      const r = await withTimeout(
        client.chat.completions.create({
          model: spec.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }), timeoutMs, spec.model);
      answer = r.choices[0]?.message?.content ?? '';
      tokensIn = r.usage?.prompt_tokens ?? 0;
      tokensOut = r.usage?.completion_tokens ?? 0;
    }

    return {
      ok: true,
      answer,
      latency_ms: Date.now() - start,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_estimate_usd: estimateCost(spec, tokensIn, tokensOut),
      model: spec.model,
      provider: spec.provider,
    };
  } catch (e: any) {
    return baseFail(e?.message || 'unknown_error');
  }
}

export function buildJudgePrompt(query: string, claim: string): string {
  return [
    `Question: ${query}`,
    `Proposed answer: ${claim}`,
    `Is this answer correct? Respond with exactly one of: CORRECT, INCORRECT, or UNCERTAIN.`,
    `Then in one sentence, state what the actual answer is.`,
  ].join('\n');
}

export type Vote = 'CORRECT' | 'INCORRECT' | 'UNCERTAIN';

export function parseVote(answerText: string): { vote: Vote; correction: string } {
  const upper = answerText.trim().toUpperCase();
  let vote: Vote = 'UNCERTAIN';
  if (/^INCORRECT/.test(upper)) vote = 'INCORRECT';
  else if (/^CORRECT/.test(upper)) vote = 'CORRECT';
  else if (/^UNCERTAIN/.test(upper)) vote = 'UNCERTAIN';
  else if (/INCORRECT/.test(upper)) vote = 'INCORRECT';
  else if (/CORRECT/.test(upper) && !/UNCERTAIN/.test(upper)) vote = 'CORRECT';

  // Extract the "actual answer" sentence — second non-empty line, or the
  // remainder after the verdict word.
  const lines = answerText.split('\n').map(l => l.trim()).filter(Boolean);
  let correction = '';
  if (lines.length >= 2) {
    correction = lines.slice(1).join(' ').trim();
  } else if (lines.length === 1) {
    correction = lines[0]!.replace(/^(CORRECT|INCORRECT|UNCERTAIN)[.:\s-]*/i, '').trim();
  }
  return { vote, correction };
}
