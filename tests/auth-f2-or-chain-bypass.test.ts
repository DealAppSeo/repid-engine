/**
 * f2-authz OR-chain bypass (found 2026-07-31 by adversarial review, fixed same day).
 *
 * THE DEFECT
 * ----------
 * The bound-identity check built ONE target from an OR-chain:
 *
 *   const targetAgentId = req.body?.agent_id || req.body?.buyer_agent_id
 *                      || req.body?.requestor_agent_id || req.body?.provider_agent_id || ...
 *
 * `||` collapses to the first truthy value, so exactly one identity was ever
 * compared and every other identity in the same request went unexamined.
 *
 * THE EXPLOIT
 * -----------
 * Hold a legitimate key bound to your own agent, then send:
 *
 *   { agent_id: <your own id>, provider_agent_id: <victim's id>, ... }
 *
 * The check reads agent_id, matches, passes. provider_agent_id is never looked
 * at, so the request proceeds under the VICTIM's identity — submitting bids or
 * listing services as them, poisoning their pricing and delivery record. Where
 * a UNIQUE(rfq_id, provider_agent_id) constraint exists, one forged request
 * also permanently locks the real agent out of that auction.
 *
 * Every case below fails against the OR-chain and passes against the fix.
 */
import { authMiddleware } from '../src/middleware/auth';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const VICTIM = 'bbbbbbbb-1111-2222-3333-444444444444';

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
    key === 'bound-key' ? { agent_id: 'aaaaaaaa-1111-2222-3333-444444444444' } : null
  ),
}));

jest.mock('../src/engine/agent-log', () => ({
  logAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

function run(body: Record<string, unknown>, query: Record<string, unknown> = {}) {
  const req: any = {
    method: 'POST',
    path: '/api/v1/services',
    headers: { authorization: 'Bearer bound-key' },
    ip: '127.0.0.1',
    body,
    query,
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
});

describe('f2-authz checks EVERY claimed identity, not just the first', () => {
  it('THE EXPLOIT: own agent_id first, victim provider_agent_id second → 403', async () => {
    const { res, next } = await run({ agent_id: BOUND, provider_agent_id: VICTIM });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.provider_agent_id');
  });

  it('same exploit via buyer_agent_id → 403', async () => {
    const { res, next } = await run({ agent_id: BOUND, buyer_agent_id: VICTIM });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('same exploit via requestor_agent_id → 403', async () => {
    const { res, next } = await run({ agent_id: BOUND, requestor_agent_id: VICTIM });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('order does not matter — victim id first also 403s', async () => {
    const { res } = await run({ provider_agent_id: VICTIM, agent_id: BOUND });
    expect(res.statusCode).toBe(403);
  });

  it('the query string is not a way around it', async () => {
    const { res, next } = await run({ agent_id: BOUND }, { provider_agent_id: VICTIM });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('query.provider_agent_id');
  });

  it('three ids where only the first matches → still 403', async () => {
    const { res } = await run({ agent_id: BOUND, buyer_agent_id: BOUND, provider_agent_id: VICTIM });
    expect(res.statusCode).toBe(403);
  });
});

describe('legitimate requests are NOT broken by the stricter check', () => {
  it('a single self-referencing id passes', async () => {
    const { res, next } = await run({ buyer_agent_id: BOUND });
    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalled();
  });

  it('several fields all naming the bound agent pass', async () => {
    const { next } = await run({ agent_id: BOUND, buyer_agent_id: BOUND, provider_agent_id: BOUND });
    expect(next).toHaveBeenCalled();
  });

  it("the bound agent's NAME is still accepted where an id is expected", async () => {
    const { next } = await run({ agent_id: 'trinity-bound-agent' });
    expect(next).toHaveBeenCalled();
  });

  it('a body with no identity fields passes untouched', async () => {
    const { next } = await run({ service_id: 'x', payload: { q: 'hi' } });
    expect(next).toHaveBeenCalled();
  });

  it('non-string identity values are ignored rather than crashing', async () => {
    const { next } = await run({ agent_id: BOUND, provider_agent_id: null, buyer_agent_id: 42 });
    expect(next).toHaveBeenCalled();
  });
});
