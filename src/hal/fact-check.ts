/**
 * HAL fact-check evaluator — question-shaped cross-LLM truth signal.
 *
 * WHY THIS EXISTS (CC2 calibration, 2026-05-23): the extractor (strictness:1)
 * cannot discriminate truth on short factual deliverables (harm/scope flat 0.00,
 * epistemic constant 0.45). And the patent comma-BFT agreement lib
 * (src/hal/lib/*) compares provider *answers to a declarative prompt* — which
 * measures phrasing similarity, NOT truth (a false "Berlin is the capital of
 * France" scored HIGHER agreement than the true "Paris"). It also inflates the
 * score when a provider rate-limits (agreement→0).
 *
 * This module takes the opposite, question-shaped approach: ask each free
 * provider to VERIFY the claim (TRUE/FALSE/UNCERTAIN + confidence as JSON), then
 * aggregate verdicts into a 0..1 hal_score (higher = more likely false/risky).
 * It does NOT touch the patent lib (which stays the canonical comma-BFT path).
 *
 * Resilient (RULE-8): bounded per-provider timeout, Promise.allSettled, degrades
 * gracefully (3→2→1→0 providers); 0 providers → caller falls back to extractor.
 */

import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import { recordProviderCall } from '../cache/provider-health'; // S-CACHE — real-time provider health
import crypto from 'crypto';
import {
  sbfaConsensus,
  votesFromVerdicts,
  ConstantReliabilityOracle,
  type SbfaDecision,
  type SbfaTrace,
  type StakesLevel,
  type ActionKind,
} from './sbfa-consensus';
import { queryOpenAI } from './lib/openai';
import { reliabilityOracle } from '../services/hal-reliability-oracle';

export interface FactCheckProviderCfg {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  family?: string; // R5 — independent model family (groq-Llama + cerebras-Llama = ONE family/vote)
  tier?: 'free' | 'cheap' | 'escalation'; // R6 — cost class for cheapest-first quorum assembly
  callType?: 'openai-compat' | 'anthropic-native';
}

/**
 * Build the active universal provider set. Default active quorum contains
 * OpenAI (gpt-4o-mini), Anthropic (claude-haiku-4-5-20251001), and DeepSeek (deepseek-chat).
 * For reasoning claims, DeepSeek Reasoner (deepseek-reasoner) is appended to the quorum.
 */
export function buildUniversalProviders(route: 'FACT' | 'REASONING'): FactCheckProviderCfg[] {
  const out: FactCheckProviderCfg[] = [
    {
      name: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: 'gpt-4o-mini',
      family: 'openai',
      tier: 'cheap',
      callType: 'openai-compat'
    },
    {
      name: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: 'claude-haiku-4-5-20251001',
      family: 'anthropic',
      tier: 'escalation',
      callType: 'anthropic-native'
    },
    {
      name: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: 'deepseek-chat',
      family: 'deepseek',
      tier: 'cheap',
      callType: 'openai-compat'
    }
  ];

  if (route === 'REASONING') {
    out.push({
      name: 'deepseek-reasoner',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: 'deepseek-reasoner',
      family: 'deepseek',
      tier: 'cheap',
      callType: 'openai-compat'
    });
  }

  return out;
}

/**
 * R6 — cost class for cheapest-first quorum assembly. free (groq/gemini/cerebras/mistral/qwen) →
 * cheap-paid (deepseek) → escalation (fireworks/anthropic/openai/asi1/togetherai/litellm). The quorum
 * stops escalating the moment >= 2 distinct families respond, so pricier providers are only paid for
 * when the free tier can't form a quorum.
 */
export function costTierOf(p: { name: string; family?: string }): 'free' | 'cheap' | 'escalation' {
  const k = `${p.name} ${p.family ?? ''}`.toLowerCase();
  if (/groq|gemini|gemma|cerebras|glm|zai|mistral|mixtral|qwen|llama/.test(k)) return 'free';
  if (/deepseek/.test(k)) return 'cheap';
  return 'escalation'; // fireworks/anthropic/openai/asi1/togetherai/litellm/cohere/kimi
}

/**
 * R5 — map a model name to its independent FAMILY. Quorum counts DISTINCT families, not hosts: two
 * hosts serving the same base model (e.g. groq + a mis-configured cerebras both on Llama) are ONE
 * independent vote, not two. Keyed by model so a host swapping models is reclassified automatically.
 */
export function familyOf(model: string): string {
  const m = (model || '').toLowerCase();
  if (/deepseek/.test(m)) return 'deepseek';
  if (/llama/.test(m)) return 'llama';
  if (/glm|zai/.test(m)) return 'glm';
  if (/kimi|moonshot/.test(m)) return 'kimi';
  if (/gemini|gemma/.test(m)) return 'gemini';
  if (/mistral|mixtral|ministral/.test(m)) return 'mistral';
  if (/qwen/.test(m)) return 'qwen';
  if (/gpt|o1|o3|o4/.test(m)) return 'openai';
  if (/claude/.test(m)) return 'anthropic';
  return m.split(/[-/:]/)[0] || 'unknown';
}

export type Verdict = 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'ERROR';

export interface ProviderVerdict {
  provider: string;
  // CC2: model is a first-class, declared field so the per-provider model string survives the
  // verdicts -> provider_responses -> hal_validation_runs path (the 06-08 model='unknown' was a
  // stale branch that predated model plumbing; declaring it here prevents a silent future drop).
  model?: string;
  verdict: Verdict;
  confidence: number; // 0..100
  note?: string;
  error?: string;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
}

export type HalDecision = 'vetoed' | 'flagged' | 'clean' | 'abstain';

export interface FactCheckResult {
  hal_score: number; // 0..1, higher = more likely false/risky (matches HAL convention)
  decision: HalDecision;
  // A1 — human-readable explanation of WHY (verdict mode), e.g. "2 of 3 independent model
  // families judged this claim FALSE (Groq/Llama, Gemini, DeepSeek)". The demo surface.
  decision_reason?: string;
  verdicts: ProviderVerdict[];
  providers_used: number; // non-error responses
  families_used?: number; // R5 — distinct independent families among the non-error responses
  families?: string[];    // R5 — the distinct families that voted
  agreement: number | null; // fraction sharing the modal non-error verdict
  degraded: boolean; // < 2 providers responded
  latency_ms: number;
  // --- CC1 2026-05-23 provider-failure hardening (additive, all optional →
  // backward-compatible; existing callers keep working unchanged). ---
  quorum?: 'full' | 'partial' | 'low' | 'outage'; // succeeded vs attempted
  provider_health?: {
    attempted: number;
    succeeded: number;
    failed: Array<{ name: string; error: string }>;
  };
  quorum_note?: string; // set only when the resilience gate downgraded a decision
  fallback_used?: 'local_slm';
  confidence?: 'degraded';
  evidence?: {
    veto_rule: string;
    vetoing_providers: Array<{ name: string; verdict: string; confidence: number; note?: string }>;
    retrieved_snippets?: string[];
    recalled_snippets?: string[];
    context_source?: 'model_recalled' | 'grounded' | 'unverified';
    average_risk: number;
    families_voted: string[];
    veto_suppressed?: boolean;
    suppression_reason?: string;
  };
  // --- SBFA v0.2 shadow (additive; default-on SHADOW only, never changes `decision`). Exposes the
  // belief / ignorance / confidence the verdict event needs (§7 CC). The decision-replacement path is
  // a SEPARATE flag gated on the A6 co-sign with GA. See src/hal/sbfa-consensus.ts. ---
  sbfa?: {
    decision: SbfaDecision; // 'act' | 'hold' | 'abstain' | 'escalate' (shadow — advisory only)
    belief: number; // DST mass on {act warranted}
    belief_not: number; // DST mass on {no action}
    ignorance_mass: number; // DST mass on {uncertain} (Yager)
    confidence: number; // 1 − ignorance
    weighted_agreement: number;
    escalate_to: 'contested_bft' | null;
    correlated_warning: boolean;
    comma_conservative: boolean;
    reliability_source: string;
    enforced: boolean; // true only if SBFA actually changed the live decision (A6-gated)
    trace: SbfaTrace; // GLASS BOX — structured + human-readable decision trace (wrapper + HITL PWA)
    honesty: {
      prompt_hash: string; // hashText(deliverable)
      decision_text_hash: string; // hashText(decision + reason + sbfa decision)
      nonce: string; // fresh per verdict
      timestamp: string; // ISO-8601 — binds the decision time (anti-backdate)
    };
  };
}

/**
 * SBFA shadow telemetry sink — pluggable, OFF the hot path. Default logs a structured one-liner
 * (visible in Railway logs, zero DB dependency). GA can replace it with a DB writer for the Gate-ON
 * measurement. NEVER called synchronously in the request path — see the sampled setImmediate below.
 */
export type SbfaTelemetry = (row: {
  live_decision: HalDecision;
  sbfa_decision: SbfaDecision;
  belief: number;
  ignorance_mass: number;
  weighted_agreement: number;
  enforced: boolean;
}) => void;
let sbfaTelemetrySink: SbfaTelemetry = (row) => {
  console.log(`[sbfa-shadow] live=${row.live_decision} sbfa=${row.sbfa_decision} belief=${row.belief.toFixed(3)} ign=${row.ignorance_mass.toFixed(3)} agree=${row.weighted_agreement.toFixed(3)} enforced=${row.enforced}`);
};
/** Test/GA seam to swap the telemetry sink (e.g. a DB writer). */
export function setSbfaTelemetrySink(sink: SbfaTelemetry): void {
  sbfaTelemetrySink = sink;
}

/** Map fact-check thresholds onto SBFA stakes/action. Reversible safety surface = protective. */
function sbfaStakes(): StakesLevel {
  const s = (process.env.HAL_SBFA_STAKES ?? 'medium').toLowerCase();
  return s === 'low' || s === 'high' || s === 'irreversible' ? (s as StakesLevel) : 'medium';
}
function sbfaAction(): ActionKind {
  // HAL veto is a reputation penalty (reversible via dispute) → protective by default; set
  // HAL_SBFA_ACTION=punitive to apply the irreversible-slash bar.
  return process.env.HAL_SBFA_ACTION === 'punitive' ? 'punitive' : 'protective';
}
/** ~10% sampling for the OFF-hot-path shadow telemetry. SBFA_SHADOW_SAMPLE_RATE in [0,1], default 0.1. */
function sbfaSampleHit(): boolean {
  const r = Number(process.env.SBFA_SHADOW_SAMPLE_RATE);
  const rate = Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.1;
  return Math.random() < rate;
}

export interface FactCheckOpts {
  vetoThreshold?: number; // default 0.5
  flagThreshold?: number; // default 0.35
  perProviderTimeoutMs?: number; // default 12000
  maxTokens?: number; // default 120
  contextSource?: 'model_recalled' | 'grounded' | 'unverified';
  category?: string;
}

const FACT_CHECK_SYSTEM =
  'You are a meticulous fact-checker. Judge ONLY factual accuracy against widely-accepted references. Be decisive. Output ONLY compact JSON.';

function factCheckPrompt(deliverable: string, context?: string): string {
  let prompt = '';
  if (context) {
    prompt += `Retrieved Context:\n${context}\n\n`;
  }
  prompt += 'Assess whether the following statement is factually true.\n' +
    `Statement: "${deliverable.replace(/"/g, "'").slice(0, 1200)}"\n\n` +
    'Reply with ONLY this JSON (no prose, no markdown):\n' +
    '{"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0-100,"note":"<=12 words"}\n' +
    '- TRUE: central factual claim is correct.\n' +
    '- FALSE: contains a factual error.\n' +
    '- UNCERTAIN: opinion, ambiguous, or not verifiable.';
  return prompt;
}

/** Extract a verdict from possibly-verbose model output (reasoning models emit prose THEN JSON). */
function parseVerdict(text: string): { verdict: Verdict; confidence: number; note?: string } {
  // Scan ALL brace-groups and prefer the one that actually carries a "verdict" key — a reasoning
  // model emits chain-of-thought (sometimes with braces) before the final JSON, so the first
  // match isn't reliably the answer.
  const candidates = text.match(/\{[\s\S]*?\}/g) ?? [];
  const ordered = [
    ...candidates.filter((c) => /verdict/i.test(c)),
    ...candidates.filter((c) => !/verdict/i.test(c)),
  ];
  for (const c of ordered) {
    try {
      const o = JSON.parse(c);
      if (o.verdict === undefined && o.confidence === undefined) continue;
      const v = String(o.verdict ?? '').toUpperCase();
      const verdict: Verdict = v === 'TRUE' || v === 'FALSE' || v === 'UNCERTAIN' ? (v as Verdict) : 'UNCERTAIN';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 50;
      confidence = Math.max(0, Math.min(100, confidence));
      return { verdict, confidence, note: typeof o.note === 'string' ? o.note.slice(0, 80) : undefined };
    } catch {
      /* try next candidate */
    }
  }
  // Fallback keyword scan if no parseable verdict JSON. Prefer an explicit "verdict": value over a
  // bare TRUE/FALSE token appearing in reasoning prose.
  const up = text.toUpperCase();
  const vm = up.match(/"VERDICT"\s*:\s*"(TRUE|FALSE|UNCERTAIN)"/);
  if (vm) return { verdict: vm[1] as Verdict, confidence: 60 };
  return { verdict: 'UNCERTAIN', confidence: 50 };
}

function buildHeaders(cfg: FactCheckProviderCfg): Record<string, string> {
  if (cfg.callType === 'anthropic-native') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
  };
}

/**
 * POST to a chat endpoint with a single jittered retry on HTTP 429.
 * Free tiers rate-limit under burst; one short backoff turns a transient 429 into a
 * success without blowing the per-provider timeout. Honors a numeric Retry-After when present.
 */
async function postWith429Retry(cfg: FactCheckProviderCfg, body: string, signal: AbortSignal): Promise<Response> {
  const headers = buildHeaders(cfg);
  let res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers,
    body, signal,
  });
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    const waitMs = Math.min(3000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800) + Math.floor(Math.random() * 400));
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body, signal,
    });
  }
  return res;
}

async function queryProvider(
  cfg: FactCheckProviderCfg,
  deliverable: string,
  maxTokens: number,
  quorumId?: string,
  context?: string
): Promise<ProviderVerdict> {
  const start = Date.now();
  const controller = new AbortController();
  // R5 — configurable per-call timeout so one slow provider can't stall the family quorum.
  const timeoutMs = cfg.timeoutMs ?? (Number(process.env.HAL_S2_TIMEOUT_MS) || 12_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call_id = crypto.randomUUID();
  try {
    const promptText = factCheckPrompt(deliverable, context);
    const bodyStr = cfg.callType === 'anthropic-native'
      ? JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          temperature: 0,
          system: FACT_CHECK_SYSTEM,
          messages: [{ role: 'user', content: promptText }],
        })
      : JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: FACT_CHECK_SYSTEM },
            { role: 'user', content: promptText },
          ],
          max_tokens: maxTokens,
          temperature: 0,
        });

    const res = await postWith429Retry(cfg, bodyStr, controller.signal);
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logLlmCall({
        call_id,
        provider: cfg.name,
        tier: '0a',
        model: cfg.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms,
        status: 'failed',
        error_message: `HTTP ${res.status}: ${body.slice(0, 120)}`,
        task_hint: 'hal_fact_check', quorum_id: quorumId
      }).catch(err => console.error('[fact-check] logLlmCall error:', err));
      return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error: `HTTP ${res.status}: ${body.slice(0, 120)}`, latency_ms };
    }
    const data: any = await res.json();
    
    let content = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (cfg.callType === 'anthropic-native') {
      const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
      content = blocks
        .filter(b => b?.type === 'text')
        .map(b => String(b.text ?? ''))
        .join('')
        .trim();
      tokensIn = data.usage?.input_tokens || 0;
      tokensOut = data.usage?.output_tokens || 0;
    } else {
      const msg = data?.choices?.[0]?.message ?? {};
      // Also support reasoning models (deepseek-reasoner) that use reasoning_content
      content = msg.content || msg.reasoning_content || msg.reasoning || '';
      tokensIn = data.usage?.prompt_tokens || 0;
      tokensOut = data.usage?.completion_tokens || 0;
    }

    const cost_usd = calculateCost(cfg.name, cfg.model, tokensIn, tokensOut);

    if (!content.trim()) {
      logLlmCall({
        call_id,
        provider: cfg.name,
        tier: '0a',
        model: cfg.model,
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        cost_usd,
        latency_ms,
        status: 'failed',
        error_message: 'empty content',
        task_hint: 'hal_fact_check', quorum_id: quorumId
      }).catch(err => console.error('[fact-check] logLlmCall error:', err));
      return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error: 'empty content', latency_ms };
    }
    
    logLlmCall({
      call_id,
      provider: cfg.name,
      tier: '0a',
      model: cfg.model,
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      cost_usd,
      latency_ms,
      status: 'success',
      task_hint: 'hal_fact_check', quorum_id: quorumId
    }).catch(err => console.error('[fact-check] logLlmCall error:', err));

    const parsed = parseVerdict(content);
    return { provider: cfg.name, verdict: parsed.verdict, confidence: parsed.confidence, note: parsed.note, latency_ms, tokens_in: tokensIn, tokens_out: tokensOut };
  } catch (e: any) {
    const latency_ms = Date.now() - start;
    const error = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e);
    logLlmCall({
      call_id,
      provider: cfg.name,
      tier: '0a',
      model: cfg.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      latency_ms,
      status: e?.name === 'AbortError' ? 'rate_limited' : 'failed',
      error_message: error,
      task_hint: 'hal_fact_check', quorum_id: quorumId
    }).catch(err => console.error('[fact-check] logLlmCall error:', err));
    return { provider: cfg.name, model: cfg.model, verdict: 'ERROR', confidence: 0, error, latency_ms };
  } finally {
    clearTimeout(timer);
  }
}

/** Per-provider risk in [0,1]: high for confident-FALSE, low for confident-TRUE. */
function providerRisk(v: ProviderVerdict): number {
  const c = v.confidence / 100;
  if (v.verdict === 'FALSE') return 0.5 + 0.5 * c; // 0.5..1.0
  if (v.verdict === 'TRUE') return 0.5 - 0.5 * c; // 0.0..0.5
  return 0.5; // UNCERTAIN
}

/**
 * CC1 2026-05-23 — provider-failure hardening. Closes CC1's own launch-
 * verification RULE-4 caveat: strictness:2 was verified only on the happy path
 * (providers_used=2, agree=1.0); under partial provider outage (e.g. cerebras
 * 429 → a single surviving provider), a lone FALSE verdict could fire a veto
 * with no independent confirmation. A veto/flag now requires a real quorum
 * (>= MIN_QUORUM_FOR_VETO successful providers). With only one surviving
 * provider the decision defaults to 'clean' (degraded) — better a false-clean
 * (caught downstream by the F-series filter + dispute path) than a false-veto.
 *
 * This WRAPS the existing aggregation: hal_score and agreement math are
 * unchanged, and the patent comma-BFT lib (src/hal/lib/*) is untouched. Note
 * the agreement/score were already computed over successful responses only
 * (ERROR providers filtered before aggregation), so failed providers never
 * inflated the score — this gate adds the missing quorum requirement.
 */
const MIN_QUORUM_FOR_VETO = 2;

function computeQuorum(succeeded: number, attempted: number): 'full' | 'partial' | 'low' | 'outage' {
  if (succeeded === 0) return 'outage';
  if (succeeded === 1) return 'low';
  return succeeded >= attempted ? 'full' : 'partial';
}

export async function checkEntailment(claim: string, context: string): Promise<boolean> {
  const systemPrompt = 
    "You are a strict, logical natural language inference (NLI) engine. Determine if the provided context supports/entails the claim.\n" +
    "Definitions:\n" +
    "- ENTAILS: The context provides direct or indirect factual support that makes the claim true. There is no contradiction between context and claim.\n" +
    "- CONTRADICTS: The context directly refutes the claim or makes it false.\n" +
    "- NEUTRAL: The context does not contain enough information to judge the claim (silent).\n\n" +
    "Output ONLY a JSON object (no markdown, no prose):\n" +
    '{"entails": true|false, "rationale": "one sentence explanation"}';

  const userPrompt = `Context:\n${context}\n\nClaim: "${claim}"`;

  try {
    const raw = await queryOpenAI(userPrompt, systemPrompt, true);
    const parsed = JSON.parse(raw);
    return parsed.entails === true;
  } catch (e: any) {
    console.error("[entailment] check failed:", e.message);
    return false;
  }
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Evaluate a deliverable's factual truth via cross-provider verdicts.
 * Falls back gracefully when providers fail; returns providers_used=0 (caller
 * should then use the extractor signal) when none respond.
 */
export async function factCheck(
  deliverable: string,
  providers: FactCheckProviderCfg[],
  opts: FactCheckOpts = {},
  context?: string,
): Promise<FactCheckResult> {
  const start = Date.now();
  const vetoThreshold = opts.vetoThreshold ?? 0.5;
  const flagThreshold = opts.flagThreshold ?? 0.35;
  // Reasoning models (cerebras zai-glm) spend tokens thinking before emitting the verdict JSON;
  // 120 truncated them mid-reasoning. 512 lets them finish while staying cheap for the terse models.
  const maxTokens = opts.maxTokens ?? 512;

  const quorumId = crypto.randomUUID(); // R5 — groups this quorum's provider calls in llm_call_log
  const familyByName = new Map(providers.map((p) => [p.name, p.family ?? familyOf(p.model)]));
  const callOne = (p: FactCheckProviderCfg) => queryProvider(p, deliverable, maxTokens, quorumId, context);
  const settle = async (ps: FactCheckProviderCfg[]): Promise<ProviderVerdict[]> => {
    const s = await Promise.allSettled(ps.map(callOne));
    return s.map((r, i) => r.status === 'fulfilled' ? r.value
      : { provider: ps[i]!.name, model: ps[i]!.model, verdict: 'ERROR' as Verdict, confidence: 0, error: String((r as PromiseRejectedResult).reason), latency_ms: 0 });
  };
  const distinctFamilies = (vs: ProviderVerdict[]) =>
    new Set(vs.filter((v) => v.verdict !== 'ERROR').map((v) => familyByName.get(v.provider) ?? v.provider)).size;

  // R6 — CHEAPEST-FIRST quorum assembly: call free → cheap → escalation in waves, stopping the moment
  // >= MIN_QUORUM_FOR_VETO distinct families respond (so paid providers are only hit when free can't
  // form a quorum). Revertible via HAL_QUORUM_COST_ORDERED=false (→ all providers in parallel, prior).
  const costOrdered = process.env.HAL_QUORUM_COST_ORDERED !== 'false';
  let verdicts: ProviderVerdict[] = [];
  let attempted = 0;
  if (costOrdered) {
    const rank = (p: FactCheckProviderCfg) => ({ free: 0, cheap: 1, escalation: 2 })[p.tier ?? costTierOf({ name: p.name, family: familyByName.get(p.name) })];
    const waves = [0, 1, 2].map((r) => providers.filter((p) => rank(p) === r)).filter((w) => w.length > 0);
    for (const wave of waves) {
      verdicts.push(...(await settle(wave)));
      attempted += wave.length;
      if (distinctFamilies(verdicts) >= MIN_QUORUM_FOR_VETO) break; // quorum formed — don't escalate to pricier tiers
    }
  } else {
    verdicts = await settle(providers);
    attempted = providers.length;
  }

  const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
  const providers_used = ok.length;
  const latency_ms = Date.now() - start;

  // R5 — distinct independent FAMILIES among the successful providers (groq-Llama + cerebras-Llama = 1).
  const familiesSet = new Set(ok.map((v) => familyByName.get(v.provider) ?? v.provider));
  const families = [...familiesSet];
  const families_used = families.length;
  // Quorum is counted in families by default; HAL_QUORUM_FAMILY_AWARE=false reverts to host count.
  const familyAware = process.env.HAL_QUORUM_FAMILY_AWARE !== 'false';
  const quorumCount = familyAware ? families_used : providers_used;

  // S-CACHE Phase 5 — record real-time provider health from the quorum (no-op without REDIS_URL).
  for (const v of verdicts) void recordProviderCall(v.provider, v.verdict !== 'ERROR', v.latency_ms);

  // CC1 provider-failure hardening: surface per-provider health + quorum.
  const failed = verdicts
    .filter((v) => v.verdict === 'ERROR')
    .map((v) => ({ name: v.provider, error: v.error ?? 'unknown' }));
  const quorum = computeQuorum(providers_used, attempted);

  if (providers_used === 0) {
    if (process.env.HAL_LOCAL_FALLBACK_ENABLED === 'true') {
      const localVerdict: Verdict = deliverable.toLowerCase().includes('false') || deliverable.toLowerCase().includes('error') ? 'FALSE' : 'TRUE';
      const localScore = localVerdict === 'FALSE' ? 0.8 : 0.2;
      const localDecision = localScore >= vetoThreshold ? 'vetoed' : localScore >= flagThreshold ? 'flagged' : 'clean';
      return {
        hal_score: localScore,
        decision: localDecision,
        verdicts: [{
          provider: 'local_slm',
          verdict: localVerdict,
          confidence: 70,
          note: 'local slm fallback heuristic',
          latency_ms: Date.now() - start,
        }],
        providers_used: 1,
        agreement: 1.0,
        degraded: true,
        latency_ms: Date.now() - start,
        quorum,
        provider_health: { attempted: attempted, succeeded: 0, failed },
        fallback_used: 'local_slm',
        confidence: 'degraded',
      };
    }

    // No truth signal available — throw error to fail loud
    throw new Error(`Fact-check BFT quorum failed: all providers failed or rate-limited. Attempted ${attempted} providers.`);
  }

  const hal_score = ok.reduce((s, v) => s + providerRisk(v), 0) / providers_used;
  // Modal verdict agreement (TRUE/FALSE/UNCERTAIN).
  const counts: Record<string, number> = {};
  for (const v of ok) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  const modal = Math.max(...Object.values(counts));
  const agreement = modal / providers_used;

  // Family-aware verdict tallies (the explainability primitive).
  const famsOf = (want: Verdict) =>
    [...new Set(ok.filter((v) => v.verdict === want).map((v) => familyByName.get(v.provider) ?? v.provider))];
  const falseFams = famsOf('FALSE');
  const trueFams = famsOf('TRUE');

  // LIFT RECALL: One-High-Conf-False veto rule
  const hasHighConfFalse = ok.some((v) => v.verdict === 'FALSE' && v.confidence >= 90);
  const meetsVetoScore = hal_score >= 0.43 && families_used >= 2;

  // Fetch reliability weights from oracle for each successful provider
  const category = opts.category ?? 'factual';
  const providerWeights = await Promise.all(
    ok.map(async (v) => {
      const w = await reliabilityOracle.getProviderWeight(v.provider, category);
      return { provider: v.provider, weight: w };
    })
  );
  const weightMap = new Map(providerWeights.map((pw) => [pw.provider, pw.weight]));

  // Calculate weighted false ratio
  const totalWeight = ok.reduce((s, v) => s + (weightMap.get(v.provider) ?? 1.0), 0);
  const falseWeight = ok
    .filter((v) => v.verdict === 'FALSE')
    .reduce((s, v) => s + (weightMap.get(v.provider) ?? 1.0), 0);
  const weightedFalseRatio = totalWeight > 0 ? falseWeight / totalWeight : 0;

  // No single provider (or single family) can veto
  const falseProviders = ok.filter((v) => v.verdict === 'FALSE');
  const falseFamilies = new Set(falseProviders.map((v) => familyByName.get(v.provider) ?? v.provider));
  const hasMultipleFalseFamilies = falseFamilies.size >= 2;

  // Legacy veto rule (Gate-OFF)
  let baseDecision: FactCheckResult['decision'] = hal_score >= vetoThreshold ? 'vetoed' : hal_score >= flagThreshold ? 'flagged' : 'clean';

  // Phase 1: Evidence-grounding veto suppression
  let vetoSuppressed = false;
  if (baseDecision === 'vetoed' && hasHighConfFalse && context && context.trim().length > 0) {
    // Check if it's a lone high-conf-FALSE veto (meaning <= 1 provider voted FALSE)
    const falseCount = ok.filter(v => v.verdict === 'FALSE').length;
    if (falseCount <= 1) {
      // Check if retrieved/recalled context entails the claim
      const entails = await checkEntailment(deliverable, context);
      if (entails) {
        vetoSuppressed = true;
        // Suppress veto: downgrade decision to flagged or clean based on average risk score
        baseDecision = hal_score >= flagThreshold ? 'flagged' : 'clean';
      }
    }
  }

  let decision: HalDecision;
  let decision_reason: string | undefined;
  let quorum_note: string | undefined;

  if (process.env.HAL_DECISION_MODE === 'verdict') {
    // A1 — VERDICT-COUNT as the PRIMARY decision (explainability refactor). Family-aware verdict
    // counts drive the decision; hal_score is demoted to a logged secondary signal. Counting
    // distinct FALSE families (not a 0.5 score on UNCERTAIN) is what a non-expert can read.
    const falseN = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
    const trueN = familyAware ? trueFams.length : ok.filter((v) => v.verdict === 'TRUE').length;
    if (falseN >= MIN_QUORUM_FOR_VETO) {
      decision = 'vetoed';
      decision_reason = `${falseN} of ${familyAware ? families_used : providers_used} independent model ${familyAware ? 'families' : 'providers'} judged this claim FALSE (${falseFams.join('/')}).`;
    } else if (falseN === 1) {
      decision = 'flagged';
      decision_reason = `Only 1 ${familyAware ? 'family' : 'provider'} judged this FALSE (${falseFams.join('/')}) — no independent quorum. Flagged for review, not vetoed.`;
    } else if (trueN >= MIN_QUORUM_FOR_VETO) {
      decision = 'clean';
      decision_reason = `${trueN} independent ${familyAware ? 'families' : 'providers'} judged this claim TRUE (${trueFams.join('/')}); no FALSE verdicts.`;
    } else {
      // 0 FALSE and no TRUE quorum → nothing checkable was confirmed either way.
      decision = 'abstain';
      decision_reason = `No model family judged this claim FALSE, and there is no TRUE quorum — not a checkable factual claim (likely an opinion or a question). HAL did not judge it.`;
    }
  } else {
    // SCORE mode (default — byte-identical to prior behavior): hal_score thresholds + the
    // resilience gate + the CC1 verdict-driven gate.
    decision = baseDecision;

    // RESILIENCE GATE (CC1 2026-05-23): a veto/flag requires >= MIN_QUORUM_FOR_VETO successful
    // providers; a lone provider downgrades to 'clean'. hal_score preserved; only decision changes.
    if (quorumCount < MIN_QUORUM_FOR_VETO && baseDecision !== 'clean') {
      decision = 'clean';
      quorum_note = `Low quorum (${familyAware ? families_used + ' famil' + (families_used === 1 ? 'y' : 'ies') + ' [' + families.join(',') + ']' : providers_used + ' providers'}/${attempted} attempted): would-be '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'clean' — need >= ${MIN_QUORUM_FOR_VETO} independent ${familyAware ? 'families' : 'providers'}.`;
    }

    // CC1 verdict-driven gate (HAL_VERDICT_DRIVEN_VETO, default OFF): a 'vetoed' baseDecision with
    // no FALSE quorum downgrades to 'flagged' (the all-UNCERTAIN @0.5 over-veto W6 found).
    if (process.env.HAL_VERDICT_DRIVEN_VETO === 'true' && decision === 'vetoed') {
      const falseQuorum = familyAware ? falseFams.length : ok.filter((v) => v.verdict === 'FALSE').length;
      if (weightedFalseRatio < 0.60 || !hasMultipleFalseFamilies) {
        decision = 'flagged';
        quorum_note = `Verdict-driven gate: no FALSE quorum (${falseQuorum} FALSE < ${MIN_QUORUM_FOR_VETO}); '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'flagged' — UNCERTAIN/opinion, not a confirmed factual error.`;
      }
    }
  }

  // --- SBFA v0.2 SHADOW + GLASS BOX (default ON). ZERO extra inference: it reuses the per-provider
  // verdicts already computed and makes NO new LLM calls. The decision trace is pure DST math (sub-ms),
  // attached to EVERY decision so the wrapper + HITL PWA always have the Glass Box (§7 CC, task 3).
  // The live `decision` is NOT changed unless HAL_SBFA_ENFORCE=true (A6-gated, defer-only). Telemetry
  // persistence for the Gate-ON measurement is SAMPLED (~10%) and fired OFF the hot path (setImmediate,
  // never awaited) — so prod never eats latency and the shadow can never block a live decision. ---
  let sbfaField: FactCheckResult['sbfa'];
  if (process.env.HAL_SBFA_SHADOW !== 'false') {
    try {
      const votes = votesFromVerdicts(verdicts);
      // Placeholder oracle until GA wires the verified-outcome oracle (§2.1). NOT a real reliability source.
      const oracle = new ConstantReliabilityOracle(0.7, 4);
      const v = sbfaConsensus({ votes, stakes: sbfaStakes(), action: sbfaAction(), category: 'factual', oracle });
      let enforced = false;
      if (process.env.HAL_SBFA_ENFORCE === 'true' && decision === 'vetoed' && (v.decision === 'abstain' || v.decision === 'escalate')) {
        // A6-gated: SBFA says "insufficient consensus / defer" → downgrade the veto to flagged (defer,
        // do not punish). Never the reverse. Logged loudly so the override is auditable.
        decision = 'flagged';
        enforced = true;
        quorum_note = `SBFA v0.2 ${v.decision} (belief ${v.belief_act.toFixed(3)}, ignorance ${v.ignorance_mass.toFixed(3)}): would-be 'vetoed' deferred to 'flagged'. ${v.reason}`;
      }
      const nonce = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const prompt_hash = hashText(deliverable);
      const decision_text_hash = hashText(decision + (decision_reason || quorum_note || '') + v.decision);
      const honesty = {
        prompt_hash,
        decision_text_hash,
        nonce,
        timestamp,
      };
      sbfaField = {
        decision: v.decision,
        belief: v.belief_act,
        belief_not: v.belief_not,
        ignorance_mass: v.ignorance_mass,
        confidence: v.confidence,
        weighted_agreement: v.weighted_agreement,
        escalate_to: v.escalate_to,
        correlated_warning: v.correlated_warning,
        comma_conservative: v.comma_conservative,
        reliability_source: v.reliability_source,
        enforced,
        trace: v.trace,
        honesty,
      };
      // SAMPLED (~10%), OFF-HOT-PATH telemetry for the Gate-ON measurement — fire-and-forget, never awaited.
      if (sbfaSampleHit()) {
        const liveDecision = decision; // final live decision (post-enforce)
        setImmediate(() => {
          try {
            sbfaTelemetrySink({
              live_decision: liveDecision,
              sbfa_decision: v.decision,
              belief: v.belief_act,
              ignorance_mass: v.ignorance_mass,
              weighted_agreement: v.weighted_agreement,
              enforced,
            });
          } catch {
            /* telemetry must never affect the request */
          }
        });
      }
    } catch {
      // Shadow must never break the live path — swallow and continue without the field.
      sbfaField = undefined;
    }
  }

  // Construct Auditable Evidence
  const vetoing_providers = ok
    .filter(v => (v.verdict === 'FALSE' && v.confidence >= 90) || (meetsVetoScore && v.verdict === 'FALSE') || (process.env.HAL_VERDICT_DRIVEN_VETO === 'true' && v.verdict === 'FALSE'))
    .map(v => ({ name: v.provider, verdict: v.verdict, confidence: v.confidence, note: v.note }));

  const contextSourceVal = opts.contextSource ?? (context ? 'model_recalled' : undefined);

  const evidence: FactCheckResult['evidence'] = {
    veto_rule: decision === 'vetoed'
      ? (process.env.HAL_VERDICT_DRIVEN_VETO === 'true' ? 'reliability-weighted-supermajority' : (hasHighConfFalse ? 'one-high-conf-false' : 'average-risk-quorum'))
      : (vetoSuppressed ? 'suppressed' : 'none'),
    vetoing_providers,
    context_source: contextSourceVal,
    ...(contextSourceVal === 'model_recalled'
      ? { recalled_snippets: context ? context.split('\n\n') : undefined }
      : { retrieved_snippets: context ? context.split('\n\n') : undefined }
    ),
    average_risk: hal_score,
    families_voted: families,
    ...(vetoSuppressed ? { veto_suppressed: true, suppression_reason: 'Retrieved/recalled context entails claim' } : {})
  };

  return {
    hal_score, decision, verdicts, providers_used, families_used, families, agreement, degraded: quorumCount < 2, latency_ms,
    quorum, provider_health: { attempted: attempted, succeeded: providers_used, failed },
    ...(decision_reason ? { decision_reason } : {}),
    ...(quorum_note ? { quorum_note } : {}),
    ...(sbfaField ? { sbfa: sbfaField } : {}),
    evidence
  };
}

/**
 * Resolve fact-check thresholds from env (Phase 1 — runtime-tunable, no
 * redeploy). Defaults: veto 0.5 (clear majority confidently-false), flag 0.35.
 * Calibration max-F1 was veto≈0.30 (more aggressive); set HAL_VETO_THRESHOLD
 * to tune. Clamped to [0,1]; flag never above veto.
 */
export function factCheckOptsFromEnv(): { vetoThreshold: number; flagThreshold: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d;
  };
  const vetoThreshold = num(process.env.HAL_VETO_THRESHOLD, 0.43);
  const flagThreshold = Math.min(num(process.env.HAL_FLAG_THRESHOLD, 0.35), vetoThreshold);
  return { vetoThreshold, flagThreshold };
}

/**
 * Build the free-tier fact-check provider set from env (groq + cerebras +
 * fireworks). 3 providers → majority vote + non-degraded agreement. Only
 * key-present providers are included. Models overridable via HAL_S2_*_MODEL.
 * (Fireworks default kimi-k2p5 is verbose but populates `content`; gpt-oss-120b
 * is a reasoning model with empty content — avoid.)
 */
export function buildFactCheckProviders(): FactCheckProviderCfg[] {
  const out: FactCheckProviderCfg[] = [];

  // 1. DeepSeek (primary, cost-rank: free)
  const d = process.env.DEEPSEEK_API_KEY?.trim();
  if (d) {
    out.push({
      name: 'deepseek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: d,
      model: process.env.HAL_S2_DEEPSEEK_MODEL ?? 'deepseek-chat',
      family: 'deepseek',
      tier: 'free'
    });
  }

  // 2. Cerebras (secondary, cost-rank: cheap)
  const c = process.env.CEREBRAS_API_KEY?.trim();
  if (c) {
    out.push({
      name: 'cerebras',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: c,
      model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'zai-glm-4.7',
      family: 'glm',
      tier: 'cheap'
    });
  }

  // 3. Gemini (tertiary-on-reset, cost-rank: escalation)
  const gm = process.env.GEMINI_API_KEY?.trim();
  if (gm) {
    out.push({
      name: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: gm,
      model: process.env.HAL_S2_GEMINI_MODEL ?? 'gemini-2.0-flash',
      family: 'gemini',
      tier: 'escalation'
    });
  }

  return out;
}

/**
 * A3 — FAMILY-INDEPENDENCE AUDIT. Two providers serving the same base model FAMILY (e.g. two
 * Llama endpoints) are ONE independent vote, not two; counting them as two would let a single
 * model's error form a fake "quorum" and break the dissent guarantee the whole gate rests on.
 * Returns the families that cover more than one configured provider.
 */
export function auditFamilyIndependence(providers: FactCheckProviderCfg[]): {
  independent: boolean;
  families: string[];
  collapsed: Array<{ family: string; providers: string[] }>;
} {
  const byFam = new Map<string, string[]>();
  for (const p of providers) {
    const fam = p.family ?? familyOf(p.model);
    byFam.set(fam, [...(byFam.get(fam) ?? []), p.name]);
  }
  const collapsed = [...byFam.entries()].filter(([, ps]) => ps.length > 1).map(([family, ps]) => ({ family, providers: ps }));
  return { independent: collapsed.length === 0, families: [...byFam.keys()], collapsed };
}

/**
 * A3 — loud boot-time assertion. Logs the live family map; on a collapse it logs a LOUD error and,
 * when HAL_STRICT_FAMILY_INDEPENDENCE=true, throws (default = warn-not-crash so a misconfig is
 * visible without taking the service down).
 */
export function assertFamilyIndependenceAtBoot(providers: FactCheckProviderCfg[] = buildFactCheckProviders()): void {
  const a = auditFamilyIndependence(providers);
  console.log(`[hal] fact-check quorum: ${providers.length} providers across ${a.families.length} families [${a.families.join(', ')}]`);
  if (!a.independent) {
    const msg = `[hal] *** FAMILY-INDEPENDENCE VIOLATION *** these families back >1 provider and count as ONE vote, not several — quorum dissent guarantee broken: ${a.collapsed.map((c) => `${c.family}=[${c.providers.join(',')}]`).join('; ')}`;
    console.error(msg);
    if (process.env.HAL_STRICT_FAMILY_INDEPENDENCE === 'true') throw new Error(msg);
  }
}
