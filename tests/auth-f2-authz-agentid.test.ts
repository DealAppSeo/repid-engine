/**
 * f2-authz camelCase `agentId` gap (CWE-862, Strix #1341; fixed 2026-10-13).
 *
 * THE DEFECT
 * ----------
 * The bound-identity allow-list, IDENTITY_FIELDS, covered the snake_case identity fields
 * (`agent_id`, `buyer_agent_id`, `requestor_agent_id`, `provider_agent_id`, `agent`) but NOT
 * the camelCase `agentId`. Yet POST /api/v1/score forwards req.body straight to updateRepId and
 * uses `agentId` as the scoring actor. So a key bound to agent A could send
 *
 *   { agentId: <VICTIM's id>, ... }
 *
 * and the middleware never examined it — the request proceeded under the victim's identity and
 * could move the victim's score (acutely, the confirmed-outcome verifier binds the kernel receipt
 * to this caller-supplied `agentId`, not the authenticated principal).
 *
 * THE FIX
 * -------
 * `agentId` is added to IDENTITY_FIELDS, so the camelCase field is collected and checked exactly
 * like every other identity field. A bound key naming a different agent via `agentId` is refused.
 *
 * NON-VACUITY: remove 'agentId' from IDENTITY_FIELDS in src/middleware/auth.ts and the first test
 * below goes RED (the cross-name attack is no longer refused). This suite does not pass through
 * the /score route, so the route-level belt-and-suspenders cannot mask the middleware regression.
 *
 * Mock topology mirrors tests/auth-f2-or-chain-bypass.test.ts.
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
    path: '/api/v1/score',
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

describe('f2-authz checks the camelCase `agentId` identity field', () => {
  it('THE ATTACK: a bound key naming a DIFFERENT agent via agentId → 403', async () => {
    const { res, next } = await run({ agentId: VICTIM, eventType: 'STAKE' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.agentId');
  });

  it('the confirmed-outcome shape (agentId + confirmationReceiptId) is refused the same way', async () => {
    const { res, next } = await run({
      agentId: VICTIM,
      eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', confirmationReceiptId: 'rcpt-victim' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.agentId');
  });

  it('agentId in the query string is not a way around it', async () => {
    const { res, next } = await run({ eventType: 'STAKE' }, { agentId: VICTIM });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('query.agentId');
  });

  it('agentId naming the victim alongside a matching agent_id still 403s (every field checked)', async () => {
    const { res } = await run({ agent_id: BOUND, agentId: VICTIM, eventType: 'STAKE' });
    expect(res.statusCode).toBe(403);
    expect(res.body.field).toBe('body.agentId');
  });
});

describe('legitimate requests are NOT broken by adding agentId', () => {
  it('a bound key scoring ITSELF (agentId === own id) passes', async () => {
    const { res, next } = await run({ agentId: BOUND, eventType: 'STAKE' });
    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalled();
  });

  it("the bound agent's NAME is accepted in agentId where an id is expected", async () => {
    const { next } = await run({ agentId: 'trinity-bound-agent', eventType: 'STAKE' });
    expect(next).toHaveBeenCalled();
  });

  it('a body with no agentId passes untouched', async () => {
    const { next } = await run({ eventType: 'STAKE', note: 'hi' });
    expect(next).toHaveBeenCalled();
  });

  it('a non-string agentId is ignored rather than crashing', async () => {
    const { next } = await run({ agentId: 42, eventType: 'STAKE' });
    expect(next).toHaveBeenCalled();
  });
});
