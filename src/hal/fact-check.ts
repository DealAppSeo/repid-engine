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

export interface FactCheckProviderCfg {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
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
  agreement: number | null; // fraction sharing the modal non-error verdict
  degraded: boolean; // < 2 providers responded
  latency_ms: number;
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

/** Extract the first JSON object from possibly-verbose model output. */
function parseVerdict(text: string): { verdict: Verdict; confidence: number; note?: string } {
  const m = text.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const v = String(o.verdict ?? '').toUpperCase();
      const verdict: Verdict = v === 'TRUE' || v === 'FALSE' || v === 'UNCERTAIN' ? (v as Verdict) : 'UNCERTAIN';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 50;
      confidence = Math.max(0, Math.min(100, confidence));
      return { verdict, confidence, note: typeof o.note === 'string' ? o.note.slice(0, 80) : undefined };
    } catch {
      /* fall through to keyword scan */
    }
  }
  // Fallback keyword scan if JSON parse failed.
  const up = text.toUpperCase();
  if (up.includes('"VERDICT":"FALSE"') || /\bFALSE\b/.test(up)) return { verdict: 'FALSE', confidence: 60 };
  if (up.includes('"VERDICT":"TRUE"') || /\bTRUE\b/.test(up)) return { verdict: 'TRUE', confidence: 60 };
  return { verdict: 'UNCERTAIN', confidence: 50 };
}

async function queryProvider(cfg: FactCheckProviderCfg, deliverable: string, maxTokens: number): Promise<ProviderVerdict> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? 12_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: FACT_CHECK_SYSTEM },
          { role: 'user', content: factCheckPrompt(deliverable) },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { provider: cfg.name, verdict: 'ERROR', confidence: 0, error: `HTTP ${res.status}: ${body.slice(0, 120)}`, latency_ms };
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.message?.reasoning_content ?? '';
    if (!content.trim()) return { provider: cfg.name, verdict: 'ERROR', confidence: 0, error: 'empty content', latency_ms };
    const parsed = parseVerdict(content);
    return { provider: cfg.name, verdict: parsed.verdict, confidence: parsed.confidence, note: parsed.note, latency_ms };
  } catch (e: any) {
    const latency_ms = Date.now() - start;
    const error = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e);
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
  const maxTokens = opts.maxTokens ?? 120;

  const settled = await Promise.allSettled(providers.map((p) => queryProvider(p, deliverable, maxTokens)));
  const verdicts: ProviderVerdict[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { provider: providers[i]!.name, verdict: 'ERROR', confidence: 0, error: String((s as PromiseRejectedResult).reason), latency_ms: 0 },
  );

  const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
  const providers_used = ok.length;
  const latency_ms = Date.now() - start;

  if (providers_used === 0) {
    // No truth signal available — neutral score; caller falls back to extractor.
    return { hal_score: 0.5, decision: 'flagged', verdicts, providers_used: 0, agreement: null, degraded: true, latency_ms };
  }

  const hal_score = ok.reduce((s, v) => s + providerRisk(v), 0) / providers_used;
  // Modal verdict agreement (TRUE/FALSE/UNCERTAIN).
  const counts: Record<string, number> = {};
  for (const v of ok) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  const modal = Math.max(...Object.values(counts));
  const agreement = modal / providers_used;

  const decision: FactCheckResult['decision'] =
    hal_score >= vetoThreshold ? 'vetoed' : hal_score >= flagThreshold ? 'flagged' : 'clean';

  return { hal_score, decision, verdicts, providers_used, agreement, degraded: providers_used < 2, latency_ms };
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
  const g = process.env.GROQ_API_KEY?.trim();
  if (g) out.push({ name: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: g, model: process.env.HAL_S2_GROQ_MODEL ?? 'llama-3.3-70b-versatile' });
  const c = process.env.CEREBRAS_API_KEY?.trim();
  if (c) out.push({ name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: c, model: process.env.HAL_S2_CEREBRAS_MODEL ?? 'llama3.1-8b' });
  const f = process.env.FIREWORKS_API_KEY?.trim();
  if (f) out.push({ name: 'fireworks', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', apiKey: f, model: process.env.HAL_S2_FIREWORKS_MODEL ?? 'accounts/fireworks/models/kimi-k2p5' });
  return out;
}
