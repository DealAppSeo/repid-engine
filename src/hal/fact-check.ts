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

export interface FactCheckProviderCfg {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  family?: string; // R5 — independent model family (groq-Llama + cerebras-Llama = ONE family/vote)
  tier?: 'free' | 'cheap' | 'escalation'; // R6 — cost class for cheapest-first quorum assembly
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
  verdict: Verdict;
  confidence: number; // 0..100
  note?: string;
  error?: string;
  latency_ms: number;
}

export interface FactCheckResult {
  hal_score: number; // 0..1, higher = more likely false/risky (matches HAL convention)
  decision: 'vetoed' | 'flagged' | 'clean';
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
}

export interface FactCheckOpts {
  vetoThreshold?: number; // default 0.5
  flagThreshold?: number; // default 0.35
  perProviderTimeoutMs?: number; // default 12000
  maxTokens?: number; // default 120
}

const FACT_CHECK_SYSTEM =
  'You are a meticulous fact-checker. Judge ONLY factual accuracy against widely-accepted references. Be decisive. Output ONLY compact JSON.';

function factCheckPrompt(deliverable: string): string {
  return (
    'Assess whether the following statement is factually true.\n' +
    `Statement: "${deliverable.replace(/"/g, "'").slice(0, 1200)}"\n\n` +
    'Reply with ONLY this JSON (no prose, no markdown):\n' +
    '{"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0-100,"note":"<=12 words"}\n' +
    '- TRUE: central factual claim is correct.\n' +
    '- FALSE: contains a factual error.\n' +
    '- UNCERTAIN: opinion, ambiguous, or not verifiable.'
  );
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

/**
 * POST to an OpenAI-compatible chat endpoint with a single jittered retry on HTTP 429.
 * Free tiers (esp. groq) rate-limit under burst; one short backoff turns a transient 429 into a
 * success without blowing the per-provider timeout. Honors a numeric Retry-After when present.
 */
async function postWith429Retry(cfg: FactCheckProviderCfg, body: string, signal: AbortSignal): Promise<Response> {
  let res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body, signal,
  });
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    const waitMs = Math.min(3000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800) + Math.floor(Math.random() * 400));
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body, signal,
    });
  }
  return res;
}

async function queryProvider(cfg: FactCheckProviderCfg, deliverable: string, maxTokens: number, quorumId?: string): Promise<ProviderVerdict> {
  const start = Date.now();
  const controller = new AbortController();
  // R5 — configurable per-call timeout so one slow provider can't stall the family quorum.
  const timeoutMs = cfg.timeoutMs ?? (Number(process.env.HAL_S2_TIMEOUT_MS) || 12_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const call_id = crypto.randomUUID();
  try {
    const res = await postWith429Retry(cfg, JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: FACT_CHECK_SYSTEM },
        { role: 'user', content: factCheckPrompt(deliverable) },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }), controller.signal);
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
      return { provider: cfg.name, verdict: 'ERROR', confidence: 0, error: `HTTP ${res.status}: ${body.slice(0, 120)}`, latency_ms };
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    // Reasoning models (cerebras zai-glm / gpt-oss) put output in `reasoning` or `reasoning_content`,
    // not `content` — fall through all three so they parse.
    const content: string = msg.content || msg.reasoning_content || msg.reasoning || '';
    
    const tokensIn = data.usage?.prompt_tokens || 0;
    const tokensOut = data.usage?.completion_tokens || 0;
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
      return { provider: cfg.name, verdict: 'ERROR', confidence: 0, error: 'empty content', latency_ms };
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
    return { provider: cfg.name, verdict: parsed.verdict, confidence: parsed.confidence, note: parsed.note, latency_ms };
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
    return { provider: cfg.name, verdict: 'ERROR', confidence: 0, error, latency_ms };
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

/**
 * Evaluate a deliverable's factual truth via cross-provider verdicts.
 * Falls back gracefully when providers fail; returns providers_used=0 (caller
 * should then use the extractor signal) when none respond.
 */
export async function factCheck(
  deliverable: string,
  providers: FactCheckProviderCfg[],
  opts: FactCheckOpts = {},
): Promise<FactCheckResult> {
  const start = Date.now();
  const vetoThreshold = opts.vetoThreshold ?? 0.5;
  const flagThreshold = opts.flagThreshold ?? 0.35;
  // Reasoning models (cerebras zai-glm) spend tokens thinking before emitting the verdict JSON;
  // 120 truncated them mid-reasoning. 512 lets them finish while staying cheap for the terse models.
  const maxTokens = opts.maxTokens ?? 512;

  const quorumId = crypto.randomUUID(); // R5 — groups this quorum's provider calls in llm_call_log
  const familyByName = new Map(providers.map((p) => [p.name, p.family ?? familyOf(p.model)]));
  const callOne = (p: FactCheckProviderCfg) => queryProvider(p, deliverable, maxTokens, quorumId);
  const settle = async (ps: FactCheckProviderCfg[]): Promise<ProviderVerdict[]> => {
    const s = await Promise.allSettled(ps.map(callOne));
    return s.map((r, i) => r.status === 'fulfilled' ? r.value
      : { provider: ps[i]!.name, verdict: 'ERROR' as Verdict, confidence: 0, error: String((r as PromiseRejectedResult).reason), latency_ms: 0 });
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

    // No truth signal available — neutral score; caller falls back to extractor.
    return {
      hal_score: 0.5, decision: 'flagged', verdicts, providers_used: 0, agreement: null, degraded: true, latency_ms,
      quorum, provider_health: { attempted: attempted, succeeded: 0, failed },
      quorum_note: `No provider responded (0/${attempted}); neutral score, caller falls back to extractor.`,
    };
  }

  const hal_score = ok.reduce((s, v) => s + providerRisk(v), 0) / providers_used;
  // Modal verdict agreement (TRUE/FALSE/UNCERTAIN).
  const counts: Record<string, number> = {};
  for (const v of ok) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  const modal = Math.max(...Object.values(counts));
  const agreement = modal / providers_used;

  const baseDecision: FactCheckResult['decision'] =
    hal_score >= vetoThreshold ? 'vetoed' : hal_score >= flagThreshold ? 'flagged' : 'clean';

  // RESILIENCE GATE (CC1 2026-05-23): a veto/flag requires >= MIN_QUORUM_FOR_VETO
  // successful providers. With a single surviving provider (low quorum), downgrade
  // to 'clean' — a lone provider's verdict is not enough to veto. hal_score is
  // preserved for observability; only the decision is changed.
  let decision = baseDecision;
  let quorum_note: string | undefined;
  if (quorumCount < MIN_QUORUM_FOR_VETO && baseDecision !== 'clean') {
    decision = 'clean';
    quorum_note = `Low quorum (${familyAware ? families_used + ' famil' + (families_used === 1 ? 'y' : 'ies') + ' [' + families.join(',') + ']' : providers_used + ' providers'}/${attempted} attempted): would-be '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'clean' — need >= ${MIN_QUORUM_FOR_VETO} independent ${familyAware ? 'families' : 'providers'}.`;
  }

  // CC1 verdict-driven gate (W6 fix, gated by HAL_VERDICT_DRIVEN_VETO, default OFF). A hard veto
  // must rest on a cross-provider FALSE quorum (a factual error multiple independent families
  // agree on), NOT merely hal_score >= vetoThreshold. The score path over-vetoes UNCERTAIN-dominated
  // input: every UNCERTAIN verdict scores 0.5 (providerRisk), so an all-UNCERTAIN deliverable
  // (a subjective opinion, or a question with no assertion) lands at hal_score 0.5 == vetoThreshold
  // and was vetoed — the opinion/time-sensitive over-veto W6 found. With the gate ON, a 'vetoed'
  // baseDecision with no FALSE quorum is downgraded to 'flagged' (surfaced, no hard veto / -10).
  // Factual errors (math/code/factual) still produce FALSE verdicts → FALSE quorum → veto stays.
  // This is verdict-driven, NOT category-driven (HAL_CATEGORY_SOFT_VETO stays OFF — the corpus
  // "opinion" category is contaminated with mislabeled false facts that must keep hard-vetoing).
  if (process.env.HAL_VERDICT_DRIVEN_VETO === 'true' && decision === 'vetoed') {
    const falseFamilies = new Set(
      ok.filter((v) => v.verdict === 'FALSE').map((v) => familyByName.get(v.provider) ?? v.provider),
    ).size;
    const falseQuorum = familyAware ? falseFamilies : ok.filter((v) => v.verdict === 'FALSE').length;
    if (falseQuorum < MIN_QUORUM_FOR_VETO) {
      decision = 'flagged';
      quorum_note = `Verdict-driven gate: no FALSE quorum (${falseQuorum} FALSE ${familyAware ? 'famil' + (falseQuorum === 1 ? 'y' : 'ies') : 'provider' + (falseQuorum === 1 ? '' : 's')} < ${MIN_QUORUM_FOR_VETO}); '${baseDecision}' (score ${hal_score.toFixed(3)}) downgraded to 'flagged' — UNCERTAIN/opinion, not a confirmed factual error.`;
    }
  }

  return {
    hal_score, decision, verdicts, providers_used, families_used, families, agreement, degraded: quorumCount < 2, latency_ms,
    quorum, provider_health: { attempted: attempted, succeeded: providers_used, failed },
    ...(quorum_note ? { quorum_note } : {}),
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
  const vetoThreshold = num(process.env.HAL_VETO_THRESHOLD, 0.5);
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
  // S-QUORUM (2026-06-02): groq llama-3.3-70b-versatile 429s on the free tier under any burst;
  // llama-3.1-8b-instant has a far higher free RPM and returns the same clean JSON verdict.
  const g = process.env.GROQ_API_KEY?.trim();
  if (g) out.push({ name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: g, model: process.env.HAL_S2_GROQ_MODEL ?? 'llama-3.1-8b-instant' });
  // cerebras `llama3.1-8b` 404s on this key (no access); `zai-glm-4.7` is available and returns a
  // correct verdict (in the `reasoning` field — handled in queryProvider) given enough max_tokens.
  const c = process.env.CEREBRAS_API_KEY?.trim();
  if (c) out.push({ name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: c, model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'zai-glm-4.7' });
  // R6/2026-06-04 — fireworks DROPPED from the quorum (account suspended → 100% fail, ~31% of calls
  // wasted). Now opt-in: requires HAL_S2_ENABLE_FIREWORKS=true (default OFF). Reversible: set the flag.
  const f = process.env.FIREWORKS_API_KEY?.trim();
  if (f && process.env.HAL_S2_ENABLE_FIREWORKS === 'true') out.push({ name: 'fireworks', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', apiKey: f, model: process.env.HAL_S2_FIREWORKS_MODEL ?? 'accounts/fireworks/models/kimi-k2p5' });
  // R4 — DeepSeek (cheap paid) as a reliable quorum anchor so a >= 2-provider quorum forms even when
  // the free tiers (groq/cerebras) throttle under prod burst (today they fall back to the extractor,
  // and the penalty then fail-safes to no-drain via HAL_PENALTY_REQUIRES_QUORUM). DeepSeek returns
  // HTTP 402 (unfunded) as of 2026-06-03, so it is gated OFF by default; once funded, set
  // HAL_S2_ENABLE_DEEPSEEK=true and the quorum assembles reliably. Revertible via the flag.
  const d = process.env.DEEPSEEK_API_KEY?.trim();
  if (d && process.env.HAL_S2_ENABLE_DEEPSEEK === 'true') {
    out.push({ name: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: d, model: process.env.HAL_S2_DEEPSEEK_MODEL ?? 'deepseek-chat', family: 'deepseek' });
  }
  // R5 — additional independent families so >= 2 families assemble even when groq/cerebras throttle.
  // Each gated by key + an enable flag (opt-in, revertible): set the key AND HAL_S2_ENABLE_<X>=true.
  const gm = process.env.GEMINI_API_KEY?.trim();
  if (gm && process.env.HAL_S2_ENABLE_GEMINI === 'true') {
    out.push({ name: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: gm, model: process.env.HAL_S2_GEMINI_MODEL ?? 'gemini-2.0-flash', family: 'gemini' });
  }
  const ms = process.env.MISTRAL_API_KEY?.trim();
  if (ms && process.env.HAL_S2_ENABLE_MISTRAL === 'true') {
    out.push({ name: 'mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: ms, model: process.env.HAL_S2_MISTRAL_MODEL ?? 'mistral-small-latest', family: 'mistral' });
  }
  const qw = (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY)?.trim();
  if (qw && process.env.HAL_S2_ENABLE_QWEN === 'true') {
    out.push({ name: 'qwen', endpoint: process.env.HAL_S2_QWEN_ENDPOINT ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: qw, model: process.env.HAL_S2_QWEN_MODEL ?? 'qwen-plus', family: 'qwen' });
  }
  // Tag the always-on hosts with their family (model-derived; explicit for clarity).
  for (const p of out) if (!p.family) p.family = familyOf(p.model);
  return out;
}
