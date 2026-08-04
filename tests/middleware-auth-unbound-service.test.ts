/**
 * The service-listing guard as it actually behaves inside `authMiddleware`.
 *
 * The pure-function suite pins the RULE. This one pins the WIRING, and in
 * particular the two things that are only true end-to-end:
 *
 *   1. With the switch unset — which is how production runs today — an env-key
 *      caller still passes. The fix is inert until someone flips it.
 *   2. A bound key is not double-guarded. This suite also documents, by
 *      assertion rather than by prose, the INVERTED refusal that motivated the
 *      fix: a bound agent is already 403'd on `PATCH /services/<id>` by the
 *      generic path-UUID check, because that check compares a SERVICE id to the
 *      caller's AGENT id. That refusal is a real defect and it is NOT fixed
 *      here — it lives in the load-bearing bound-key block. It is pinned so the
 *      next person to touch that block sees it fail rather than discovers it in
 *      production.
 */
import { authMiddleware } from '../src/middleware/auth';
import { PARTY_ENFORCEMENT_ENV } from '../src/middleware/contract-party-guard';

const BOUND_AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';
const SERVICE = 'dddddddd-1111-2222-3333-444444444444';

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: { agent_name: 'trinity-bound-agent' }, error: null }),
      };
      return b;
    },
  },
}));

jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn().mockImplementation(async (key: string) =>
    key === 'bound-key' ? { agent_id: 'aaaaaaaa-1111-2222-3333-444444444444' } : null,
  ),
}));

jest.mock('../src/engine/agent-log', () => ({
  logAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

function run(method: string, path: string, apiKey: string, body: Record<string, unknown> = {}) {
  const req: any = {
    method,
    path,
    headers: { authorization: `Bearer ${apiKey}` },
    ip: '127.0.0.1',
    body,
    query: {},
  };
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
  const next = jest.fn();
  return Promise.resolve(authMiddleware(req, res, next)).then(() => ({ res, next }));
}

let warnSpy: jest.SpyInstance;
let prevMode: string | undefined;

beforeEach(() => {
  process.env.REPID_API_KEYS = 'operator-key:pro';
  prevMode = process.env[PARTY_ENFORCEMENT_ENV];
  delete process.env[PARTY_ENFORCEMENT_ENV];
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  if (prevMode === undefined) delete process.env[PARTY_ENFORCEMENT_ENV];
  else process.env[PARTY_ENFORCEMENT_ENV] = prevMode;
});

function guardLines(): string[] {
  return warnSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('resource=service'));
}

describe('authMiddleware — unbound service guard, default OFF', () => {
  test.each([
    ['POST', '/api/v1/services'],
    ['PATCH', `/api/v1/services/${SERVICE}`],
    ['DELETE', `/api/v1/services/${SERVICE}`],
  ])('%s %s with an env key still passes and logs nothing', async (method, path) => {
    const { res, next } = await run(method, path, 'operator-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(guardLines()).toHaveLength(0);
  });
});

describe('authMiddleware — unbound service guard, shadow', () => {
  test('observes a delist without refusing it', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'shadow';
    const { res, next } = await run('DELETE', `/api/v1/services/${SERVICE}`, 'operator-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    const lines = guardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WOULD-REFUSE');
    expect(lines[0]).toContain(`service=${SERVICE}`);
  });

  test('a GET on the same listing is not even observed', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'shadow';
    const { next } = await run('GET', `/api/v1/services/${SERVICE}`, 'operator-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(guardLines()).toHaveLength(0);
  });
});

describe('authMiddleware — unbound service guard, enforce', () => {
  test('an env key can no longer delist another agent\'s listing', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
    const { res, next } = await run('DELETE', `/api/v1/services/${SERVICE}`, 'operator-key');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
    expect(res.body.service_id).toBe(SERVICE);
  });

  test('an env key can no longer create a listing under an arbitrary provider', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
    const { res, next } = await run('POST', '/api/v1/services', 'operator-key', {
      provider_agent_id: 'bbbbbbbb-1111-2222-3333-444444444444',
      service_type: 'verification',
      service_name: 'x',
      base_price_usdc_raw: 1,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
  });

  test('browsing and reading listings still works — closing a write hole must not break reads', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
    for (const path of ['/api/v1/services', `/api/v1/services/${SERVICE}`, '/api/v1/services/categories']) {
      const { res, next } = await run('GET', path, 'operator-key');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    }
  });

  test('contract paths keep answering with the contract vocabulary, not the service one', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
    const { res } = await run('POST', `/api/v1/contracts/${SERVICE}/escrow`, 'operator-key');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
    expect(res.body.contract_id).toBe(SERVICE);
    expect(res.body).not.toHaveProperty('service_id');
  });
});

describe('authMiddleware — the bound-key path is untouched', () => {
  test('a bound key creating its OWN listing still passes, in enforce mode', async () => {
    process.env[PARTY_ENFORCEMENT_ENV] = 'enforce';
    const { res, next } = await run('POST', '/api/v1/services', 'bound-key', {
      provider_agent_id: BOUND_AGENT,
      service_type: 'verification',
      service_name: 'x',
      base_price_usdc_raw: 1,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(guardLines()).toHaveLength(0);
  });

  test('a bound key naming ANOTHER provider is still refused by the existing f2-authz check', async () => {
    const { res, next } = await run('POST', '/api/v1/services', 'bound-key', {
      provider_agent_id: 'bbbbbbbb-1111-2222-3333-444444444444',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    // The f2-authz vocabulary, not the guard's — proof the guard did not take
    // over a request the bound-key path already owns.
    expect(res.body.error).toMatch(/agent identity mismatch/);
  });

  test(
    'KNOWN DEFECT, pinned not fixed: a bound agent is 403\'d on its own listing because the ' +
      'generic path-UUID check compares a SERVICE id to an AGENT id',
    async () => {
      const { res, next } = await run('PATCH', `/api/v1/services/${SERVICE}`, 'bound-key', {
        base_price_usdc_raw: 2,
      });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/agent_id in path mismatch/);
      // And it is the bound-key block that refused, not this lane's guard.
      expect(guardLines()).toHaveLength(0);
    },
  );
});
