/**
 * ANFIS-Ikigai v0.1 — SBFA Multi-Perspective Scorer
 *
 * Score the same (signal, profile) tuple from five orthogonal perspectives
 * using different model families. Disagreement between perspectives is
 * itself a signal — high stddev means "the LLMs see this very differently"
 * which feeds the federated-observation pipeline.
 *
 * Five perspectives:
 *   1. protagonist          — argues FOR surfacing
 *   2. antagonist           — argues AGAINST surfacing (devil's advocate)
 *   3. naive_user           — no Trinity context, no patent gates
 *   4. long_term_self       — six-months-out hindsight viewpoint
 *   5. mission_aligned_peer — peer who shares Sean's "help people help people"
 *
 * Each perspective gets a different model so the perspective-level signal
 * isn't confounded by per-model bias. Falls back to mock cleanly when keys
 * are missing or HAL_V2_MOCK=1 — no perspective ever crashes the chain.
 */

import { callModel, ModelSpec, isMockMode, providerKeyAvailable } from './anfis-llm-providers';
import { AttentionSignal, IkigaiProfile } from './anfis-ikigai-scorer';

export type PerspectiveRole =
  | 'protagonist'
  | 'antagonist'
  | 'naive_user'
  | 'long_term_self'
  | 'mission_aligned_peer';

export interface PerspectiveScore {
  perspective_role: PerspectiveRole;
  model_used: string;
  composite_score: number;
  rationale: string;
  latency_ms: number;
  cost_usd: number;
  ok: boolean;
  error?: string;
}

export interface SbfaResult {
  scores: PerspectiveScore[];
  agreement_variance: number;     // stddev across the five composite_score values
  high_disagreement: boolean;      // variance > 0.30
  total_latency_ms: number;        // wall clock (parallel)
  total_cost_usd: number;
}

export interface SbfaOptions {
  perspectives?: PerspectiveRole[];
  /** Force mock even if API keys are present. Tests use this. */
  forceMock?: boolean;
}

/**
 * Default model assignments. Every perspective uses a different family so
 * disagreement between perspectives can't be blamed on shared model bias.
 *
 * Mission-aligned-peer uses Groq's free Llama for cost reasons; falls back
 * to Anthropic (cheapest available) when GROQ_API_KEY is not present.
 */
const DEFAULT_MODEL_FOR_ROLE: Record<PerspectiveRole, ModelSpec> = {
  protagonist: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5',
    cost_per_million_in_usd: 1.0,
    cost_per_million_out_usd: 5.0,
  },
  antagonist: {
    provider: 'openai',
    model: 'gpt-5-mini',
    display_name: 'GPT-5 mini',
    cost_per_million_in_usd: 0.25,
    cost_per_million_out_usd: 2.0,
  },
  naive_user: {
    provider: 'google',
    model: 'gemini-2.5-flash',
    display_name: 'Gemini 2.5 Flash',
    cost_per_million_in_usd: 0.075,
    cost_per_million_out_usd: 0.30,
  },
  long_term_self: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5 (different prompt)',
    cost_per_million_in_usd: 1.0,
    cost_per_million_out_usd: 5.0,
  },
  mission_aligned_peer: {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    display_name: 'Llama 3.3 70B (Groq)',
    cost_per_million_in_usd: 0.0,
    cost_per_million_out_usd: 0.0,
  },
};

/**
 * Resolve a model for the role, preferring the configured model but falling
 * back to a mock-friendly default if the configured provider has no key
 * AND we are not in mock mode. The fallback path keeps the SBFA chain
 * useful even when only one provider's key is configured.
 */
function resolveModelForRole(role: PerspectiveRole): ModelSpec {
  const preferred = DEFAULT_MODEL_FOR_ROLE[role];
  if (isMockMode()) return preferred;
  if (providerKeyAvailable(preferred.provider)) return preferred;
  // Fallback: anthropic if available, then openai, then google, else preferred (which will fail gracefully).
  if (providerKeyAvailable('anthropic')) return DEFAULT_MODEL_FOR_ROLE.protagonist;
  if (providerKeyAvailable('openai'))    return DEFAULT_MODEL_FOR_ROLE.antagonist;
  if (providerKeyAvailable('google'))    return DEFAULT_MODEL_FOR_ROLE.naive_user;
  return preferred;
}

const ROLE_PROMPTS: Record<PerspectiveRole, string> = {
  protagonist:
    'You are the PROTAGONIST. Argue FOR surfacing this signal. ' +
    'Score 0-1 where 1 = strongly surface; explain in one sentence why this advances the user’s declared purpose.',
  antagonist:
    'You are the ANTAGONIST (devil’s advocate). Argue AGAINST surfacing this signal. ' +
    'Score 0-1 where 1 = strong veto recommendation; explain in one sentence what is wrong with surfacing it.',
  naive_user:
    'You are a NAIVE USER with no patent context, no Trinity context, no inside baseball. ' +
    'Score 0-1 where 1 = a naive user would benefit RIGHT NOW; explain in one sentence.',
  long_term_self:
    'You are the user’s LONG-TERM SELF six months from today. ' +
    'Score 0-1 where 1 = future-you wishes you had seen this earlier; explain in one sentence.',
  mission_aligned_peer:
    'You are a PEER who shares the user’s mission to help the last, lost, and least. ' +
    'Score 0-1 where 1 = serves that mission; explain in one sentence.',
};

const SCHEMA_INSTRUCTION =
  'Reply with one JSON line and nothing else: ' +
  '{"score": <0..1 number>, "why": "<one short sentence>"}';

function buildPrompt(
  role: PerspectiveRole,
  signal: AttentionSignal,
  profile: IkigaiProfile,
  v0CompositeScore: number,
): string {
  // SQL-keyword sanitizer note: this prompt only flows through the LLM
  // adapter (no Express body sanitizer); the sanitizer applies to inbound
  // HTTP, not to outbound LLM calls.
  const profileSummary = JSON.stringify({
    love:        profile.love_dimension.keywords,
    good_at:     profile.good_at_dimension.keywords,
    world_needs: profile.world_needs_dimension.keywords,
    paid_for:    profile.paid_for_dimension.keywords,
  });
  return [
    `You are scoring a candidate attention signal for an attention-routing system.`,
    `User's declared ikigai profile (four dimensions): ${profileSummary}`,
    `Candidate signal: """${(signal.content ?? '').slice(0, 1500)}"""`,
    `v0 baseline composite score: ${v0CompositeScore.toFixed(4)}`,
    `Perspective: ${role}`,
    ROLE_PROMPTS[role],
    SCHEMA_INSTRUCTION,
  ].join('\n');
}

/** Tolerant JSON-line parser. LLM output frequently leaks markdown fences. */
function parseScoreJson(answer: string): { score: number; rationale: string } {
  if (!answer) return { score: 0, rationale: '' };
  // Strip code fences and stray prose; find the first {...} block.
  const cleaned = answer.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(candidate);
    const score = typeof parsed.score === 'number' ? parsed.score : Number(parsed.score);
    const why = typeof parsed.why === 'string' ? parsed.why : String(parsed.why ?? '');
    if (Number.isFinite(score)) {
      return { score: clamp01(score), rationale: why.slice(0, 240) };
    }
  } catch {
    // fall through
  }
  return { score: 0, rationale: cleaned.slice(0, 240) };
}

export async function scoreFromPerspectives(
  signal: AttentionSignal,
  profile: IkigaiProfile,
  v0CompositeScore: number,
  options: SbfaOptions = {},
): Promise<SbfaResult> {
  const wallStart = Date.now();
  const roles: PerspectiveRole[] = options.perspectives ?? [
    'protagonist',
    'antagonist',
    'naive_user',
    'long_term_self',
    'mission_aligned_peer',
  ];

  // forceMock: temporarily flip HAL_V2_MOCK so the LLM adapter mocks even
  // when keys are present. Restored after the parallel call settles.
  const restoreMock = options.forceMock && process.env.HAL_V2_MOCK !== '1';
  if (restoreMock) process.env.HAL_V2_MOCK = '1';

  const calls = roles.map(async (role) => {
    const spec = resolveModelForRole(role);
    const prompt = buildPrompt(role, signal, profile, v0CompositeScore);
    const result = await callModel(spec, prompt, 4000);
    const parsed = parseScoreJson(result.answer);
    const out: PerspectiveScore = {
      perspective_role: role,
      model_used: result.model,
      composite_score: result.ok ? parsed.score : 0,
      rationale: result.ok ? parsed.rationale : (result.error ?? 'no_response'),
      latency_ms: result.latency_ms,
      cost_usd: result.cost_estimate_usd,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    };
    return out;
  });

  let scores: PerspectiveScore[];
  try {
    scores = await Promise.all(calls);
  } finally {
    if (restoreMock) delete process.env.HAL_V2_MOCK;
  }

  const okScores = scores.filter(s => s.ok).map(s => s.composite_score);
  const variance = stddev(okScores);
  const total_latency_ms = Date.now() - wallStart;
  const total_cost_usd = scores.reduce((acc, s) => acc + s.cost_usd, 0);

  return {
    scores,
    agreement_variance: round4(variance),
    high_disagreement: variance > 0.30,
    total_latency_ms,
    total_cost_usd: round8(total_cost_usd),
  };
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
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

function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}
