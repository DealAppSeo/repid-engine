/**
 * Agent testing framework — base runner + context.
 *
 * Lets Trinity-style agents exercise the MVP loop against the DEPLOYED
 * repid-engine, using a free-tier LLM (see free-llm-router.ts) for reasoning.
 * Design rules:
 *   - SAFE BY DEFAULT: a scenario returns { skip:true, reason } when its
 *     preconditions are absent (missing keys, no test agent ids, no funded
 *     wallet). It never fakes a pass and never performs a destructive/paid
 *     action without explicit env opt-in.
 *   - BOUNDED (RULE-8): every HTTP call and poll has a timeout / max tries.
 *   - READ-LEANING: assertions prefer the public read endpoints
 *     (GET /api/v1/repid/*) over privileged writes.
 */

export interface ScenarioContext {
  engineUrl: string;
  apiKey?: string;
  http: HttpClient;
  pollUntil<T>(fn: () => Promise<T>, pred: (v: T) => boolean, opts?: { tries?: number; intervalMs?: number }): Promise<{ value: T; satisfied: boolean }>;
  log: (msg: string) => void;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  body: any;
  error?: string;
}

export interface HttpClient {
  get(path: string): Promise<HttpResult>;
  post(path: string, body: unknown): Promise<HttpResult>;
}

export interface ScenarioOutcome {
  pass: boolean;
  skip?: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  description: string;
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
}

export interface ScenarioResult {
  name: string;
  pass: boolean;
  skip: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  durationMs: number;
  error?: string;
}

const DEFAULT_ENGINE = 'https://repid-engine-production.up.railway.app';
const HTTP_TIMEOUT_MS = parseInt(process.env.AGENT_TEST_HTTP_TIMEOUT_MS ?? '20000', 10);

function makeHttp(engineUrl: string, apiKey?: string): HttpClient {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> {
    const url = engineUrl.replace(/\/$/, '') + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      let parsed: any = null;
      const text = await res.text().catch(() => '');
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, ok: res.ok, body: parsed };
    } catch (e: any) {
      const reason = e?.name === 'AbortError' ? `timeout after ${HTTP_TIMEOUT_MS}ms` : (e?.message ?? String(e));
      return { status: 0, ok: false, body: null, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
  };
}

export function makeContext(): ScenarioContext {
  const engineUrl = process.env.REPID_API_URL || process.env.ENGINE_URL || DEFAULT_ENGINE;
  const apiKey = process.env.REPID_API_KEY;
  const http = makeHttp(engineUrl, apiKey);
  return {
    engineUrl,
    apiKey,
    http,
    log: (msg: string) => console.log(`    ${msg}`),
    async pollUntil<T>(fn: () => Promise<T>, pred: (v: T) => boolean, opts?: { tries?: number; intervalMs?: number }) {
      const tries = opts?.tries ?? 10;
      const intervalMs = opts?.intervalMs ?? 3000;
      let value = await fn();
      for (let i = 0; i < tries && !pred(value); i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        value = await fn();
      }
      return { value, satisfied: pred(value) };
    },
  };
}

export async function runScenario(s: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    const out = await s.run(ctx);
    return {
      name: s.name,
      pass: !!out.pass,
      skip: !!out.skip,
      reason: out.reason,
      details: out.details,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      name: s.name,
      pass: false,
      skip: false,
      error: e?.message ?? String(e),
      durationMs: Date.now() - start,
    };
  }
}

/** Canonical tier derivation (mirrors compute_tier / repid-update.computeTier). */
export function computeTier(repId: number): string {
  if (repId >= 8000) return 'VETERAN';
  if (repId >= 5000) return 'AUTONOMOUS';
  if (repId >= 1000) return 'ESTABLISHED';
  if (repId >= 500) return 'EARNING';
  return 'PROBATIONARY';
}
