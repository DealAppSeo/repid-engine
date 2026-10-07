/**
 * /api/v1/agents/<id>/spend must be reachable by the agent's OWN key and nobody else's.
 *
 * The middleware's last-segment check reads a trailing word on an /agents/ path as an agent name
 * unless it is a known route word. Without 'spend' on that list, a bound key 403'd on its own
 * spend route — the agent's owner could never use it, only an operator.
 */
import { authMiddleware } from '../src/middleware/auth';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve({ data: { agent_name: 'my-agent' }, error: null }) };
      return b;
    },
  },
}));
jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn().mockImplementation(async (key: string) => (key === 'bound-key' ? { agent_id: BOUND } : null)),
}));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));

function run(path: string) {
  const req: any = { method: 'POST', path, headers: { authorization: 'Bearer bound-key' }, ip: '127.0.0.1', body: {}, query: {} };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = jest.fn();
  return Promise.resolve(authMiddleware(req, res, next)).then(() => ({ res, next }));
}

beforeEach(() => {
  process.env.REPID_API_KEYS = 'operator-key:pro';
});

it('a bound key reaches its own agent\'s spend route', async () => {
  const { next, res } = await run(`/api/v1/agents/${BOUND}/spend`);
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).toBe(0);
});

it('a bound key cannot reach another agent\'s spend route', async () => {
  const { next, res } = await run(`/api/v1/agents/${OTHER}/spend`);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(403);
});
