/**
 * f2-authz contract-party check (2026-07-30).
 *
 * Live A2A testing showed the generic path-UUID binding check misread
 * /contracts/<uuid>/* — the UUID is a CONTRACT id, not an agent id — so every
 * agent-bound (DB-issued) key 403'd on its own contract lifecycle
 * (escrow/fulfill/satisfy/outcome), leaving A2A operator-key-only.
 *
 * New behavior for DB-bound keys on /contracts/<uuid> paths:
 *   - agent is buyer  → allowed
 *   - agent is provider → allowed
 *   - agent is neither → 403 (stronger than before: previously an operator
 *     key was the only way in, but any future bound-key bypass would have
 *     had NO membership check at all)
 *   - contract not found → falls through to the route's own 404
 * Env-allowlist operator keys carry no binding and are unaffected.
 */
import { authMiddleware } from '../src/middleware/auth';

const BOUND_AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_AGENT = 'bbbbbbbb-1111-2222-3333-444444444444';
const CONTRACT = 'cccccccc-1111-2222-3333-444444444444';

let contractRow: any = null;

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: () => Promise.resolve({ data: contractRow, error: null }),
        };
        return b;
      }
      // repid_agents lookup for boundAgentName — return nothing.
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },
  },
}));

jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn().mockImplementation(async (key: string) =>
    key === 'bound-key' ? { agent_id: 'aaaaaaaa-1111-2222-3333-444444444444' } : null
  ),
}));

jest.mock('../src/engine/agent-log', () => ({
  logAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

function run(path: string, apiKey: string) {
  const req: any = {
    method: 'POST',
    path,
    headers: { authorization: `Bearer ${apiKey}` },
    ip: '127.0.0.1',
    body: {},
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

beforeEach(() => {
  process.env.REPID_API_KEYS = 'operator-key:pro';
  contractRow = null;
});

describe('authMiddleware — contract-party authz for bound keys', () => {
  test('buyer-bound key may drive its contract', async () => {
    contractRow = { buyer_agent_id: BOUND_AGENT, provider_agent_id: OTHER_AGENT };
    const { res, next } = await run(`/api/v1/contracts/${CONTRACT}/escrow`, 'bound-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  test('provider-bound key may drive its contract', async () => {
    contractRow = { buyer_agent_id: OTHER_AGENT, provider_agent_id: BOUND_AGENT };
    const { next, res } = await run(`/api/v1/contracts/${CONTRACT}/fulfill`, 'bound-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  test('non-party bound key is rejected with 403', async () => {
    contractRow = { buyer_agent_id: OTHER_AGENT, provider_agent_id: OTHER_AGENT };
    const { res, next } = await run(`/api/v1/contracts/${CONTRACT}/outcome`, 'bound-key');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not a party/);
  });

  test('unknown contract falls through to the route (404 there, not 403 here)', async () => {
    contractRow = null;
    const { next } = await run(`/api/v1/contracts/${CONTRACT}/escrow`, 'bound-key');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('operator (env-allowlist) key is unaffected by contract paths', async () => {
    contractRow = { buyer_agent_id: OTHER_AGENT, provider_agent_id: OTHER_AGENT };
    const { next, res } = await run(`/api/v1/contracts/${CONTRACT}/escrow`, 'operator-key');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  test('agent-path binding still enforced elsewhere (regression guard)', async () => {
    // /agents/:id/mint is NOT on the public bypass list, so a bound key
    // targeting a different agent's path must still 403.
    const { res, next } = await run(`/api/v1/agents/${OTHER_AGENT}/mint`, 'bound-key');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
