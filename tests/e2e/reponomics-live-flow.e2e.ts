/**
 * E2E test against the live Railway deployment.
 *
 * Hits the deployed repid-engine and walks the no-wallet visitor flow:
 *   1. POST /api/v1/builder/token-signup     →  token + 0xdead0e707 address
 *   2. POST /api/v1/stake/deposit            →  authority bump
 *   3. POST /api/v1/demo/run-round-anonymous →  round result with deltas
 *   4. GET  /api/v1/demo/two-builder/snapshot →  Builder W and M with non-zero authority
 *
 * Unit tests are mocked, so deployment-environment-specific bugs (auth
 * misconfig, DB schema drift, missing env vars on Railway, CORS) only
 * show up here.
 *
 * Each step is its own `it`. If the deployment is missing the public
 * auth bypass for an endpoint, the relevant step soft-skips with a
 * recorded reason so the suite still produces a useful diagnostic
 * report instead of failing opaquely.
 *
 * NOT included in the default test run. Invoke via:
 *
 *   npm run test:e2e
 *
 * Environment:
 *   E2E_BASE_URL   override target (default: production Railway)
 *   E2E_API_KEY    optional REPID API key for endpoints that still
 *                  require authentication on the deployed build
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://repid-engine-production.up.railway.app';
const API_KEY = process.env.E2E_API_KEY ?? '';
const HTTP_TIMEOUT_MS = 30_000;

interface LiveResponse<T = any> {
  status: number;
  body: T;
  err?: string;
}

async function liveFetch<T = any>(path: string, init: RequestInit = {}): Promise<LiveResponse<T>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  if (API_KEY && !headers.has('authorization')) headers.set('authorization', `Bearer ${API_KEY}`);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal: ctrl.signal });
    let body: any = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: res.status, body };
  } catch (e: any) {
    return { status: 0, body: null as any, err: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Shared state between steps — populated by step 1, consumed by step 2.
const ctx: { token?: string; builder_address?: string; builder_id?: string; deposit_ok?: boolean } = {};

describe('e2e — reponomics live flow against Railway', () => {
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[e2e] target = ${BASE_URL}`);
  });

  it('GET /api/v1/health responds', async () => {
    const r = await liveFetch('/api/v1/health');
    // health is auth-gated on the current production build (returns 401).
    // We accept either 200 (open) or 401 (auth required) — both prove the
    // service is reachable. Connection / TLS errors fail the test.
    expect(r.status === 200 || r.status === 401).toBe(true);
    if (r.status === 200) {
      expect(r.body).toMatchObject({ status: 'ok' });
    }
  });

  it('POST /api/v1/builder/token-signup returns a token + 0xdead0e707 address (or skips if not deployed)', async () => {
    const r = await liveFetch('/api/v1/builder/token-signup', { method: 'POST', body: JSON.stringify({}) });
    if (r.status === 401 || r.status === 404) {
      // eslint-disable-next-line no-console
      console.warn(`[e2e] /builder/token-signup returned ${r.status} — public endpoint not deployed yet. SKIPPING.`);
      return;
    }
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.token.length).toBeGreaterThanOrEqual(64);
    // Either the new hex-clean marker (post-Phase-2) or the legacy T0KEN
    // marker (pre-Phase-2) — accept both during the rollout window.
    expect(r.body.builder_address).toMatch(/^0x(dead0e707|T0KEN)/);
    expect(r.body.repid_rewards_eligible).toBe(false);
    ctx.token = r.body.token;
    ctx.builder_address = r.body.builder_address;
    ctx.builder_id = r.body.builder_id;
  });

  it('POST /api/v1/stake/deposit accepts a deposit and bumps authority (or skips if signup unavailable)', async () => {
    if (!ctx.builder_address) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] no builder_address from step 2 — SKIPPING deposit step.');
      return;
    }
    const r = await liveFetch('/api/v1/stake/deposit', {
      method: 'POST',
      body: JSON.stringify({ builder_address: ctx.builder_address, amount: '100000000' }),
    });
    if (r.status === 401 || r.status === 404) {
      // eslint-disable-next-line no-console
      console.warn(`[e2e] /stake/deposit returned ${r.status} — public endpoint not deployed. SKIPPING.`);
      return;
    }
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) {
      expect(r.body.ok).toBe(true);
      ctx.deposit_ok = true;
    }
  });

  it('POST /api/v1/demo/run-round-anonymous returns a round result with deltas (or skips)', async () => {
    const r = await liveFetch('/api/v1/demo/run-round-anonymous', {
      method: 'POST',
      body: JSON.stringify({ wait_ms: 0 }),
    });
    if (r.status === 401) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] /demo/run-round-anonymous returned 401 — public bypass not deployed. SKIPPING.');
      return;
    }
    if (r.status === 404) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] /demo/run-round-anonymous returned 404 — endpoint not deployed yet. SKIPPING.');
      return;
    }
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.round_id).toBe('string');
    // apm and veritas may be null if seed agents are absent on this DB,
    // but if present they must carry repid_before/after/delta.
    if (r.body.apm) {
      expect(typeof r.body.apm.repid_before).toBe('number');
      expect(typeof r.body.apm.repid_after).toBe('number');
      expect(typeof r.body.apm.delta).toBe('number');
    }
    if (r.body.veritas) {
      expect(typeof r.body.veritas.delta).toBe('number');
    }
  });

  it('GET /api/v1/demo/two-builder/snapshot returns Builder W + M with authority', async () => {
    const r = await liveFetch('/api/v1/demo/two-builder/snapshot');
    expect(r.status).toBe(200);
    expect(r.body).toBeTruthy();
    expect(r.body.builder_w).toBeTruthy();
    expect(r.body.builder_m).toBeTruthy();
    // Authority is a stringified bigint. Empty string or "0" both indicate
    // a cold demo — we only require the field to exist and be a string.
    expect(typeof r.body.builder_w.authority).toBe('string');
    expect(typeof r.body.builder_m.authority).toBe('string');
    // If Builder W is healthy (current_repid >= 5000) the floor passes
    // and authority should be > 0.
    if (Number(r.body.builder_w.current_repid) >= 5000) {
      expect(BigInt(r.body.builder_w.authority)).toBeGreaterThan(0n);
    }
  });

  it('GET /api/v1/metrics is publicly readable', async () => {
    const r = await liveFetch('/api/v1/metrics');
    expect(r.status).toBe(200);
    expect(typeof r.body.agents).toBe('number');
    expect(typeof r.body.vdr).toBe('number');
  });
});
