/**
 * authMiddleware bypass for POST /api/v1/llm/complete (2026-07-29).
 *
 * The T0.5 agent gate (spec §9.1) inside the route is the designed access
 * control for anonymous hosted runs: meterRun caps anonymous callers at
 * AGENT_GATE_ANON_RUNS/day per IP (default 5), verified-email tokens raise
 * the cap, BYOK is unmetered, and a 30 req/min limiter sits in front. The
 * global authMiddleware had no bypass, so every anonymous call 401'd BEFORE
 * the gate ran — breaking TrustShell's "Try it, no code" onboarding at the
 * first run (verified live on trustshell.dev, 2026-07-29).
 *
 * These are middleware-level tests: bypassed paths must call next() without
 * touching the db; non-bypassed paths must still 401 without a key.
 */
import { authMiddleware } from '../src/middleware/auth';

jest.mock('../src/db', () => ({ db: {} }));
jest.mock('../src/engine/agent-log', () => ({
  logAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

function run(method: string, path: string, headers: Record<string, string> = {}) {
  const req: any = { method, path, headers, ip: '127.0.0.1', body: {}, query: {} };
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  const next = jest.fn();
  return Promise.resolve(authMiddleware(req, res, next)).then(() => ({ res, next }));
}

describe('authMiddleware — /llm/complete anonymous gate bypass', () => {
  test('POST /api/v1/llm/complete passes through without an API key (gate governs it)', async () => {
    const { res, next } = await run('POST', '/api/v1/llm/complete');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0); // no 401 written
  });

  test('other /llm paths are NOT bypassed — keyless call still 401s', async () => {
    const { res, next } = await run('POST', '/api/v1/llm/route-debug');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized: API key required');
  });

  test('GET /api/v1/llm/complete is NOT bypassed (bypass is POST-only)', async () => {
    const { res, next } = await run('GET', '/api/v1/llm/complete');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
