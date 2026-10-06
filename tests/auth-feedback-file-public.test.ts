/**
 * The ERC-8004 feedback file must be readable with no key, by the URI that went on chain (2026-10-06).
 *
 * MEASURED BROKEN, NOT INFERRED. The first write to carry a feedback file (repid_events 1630,
 * tx 0x4253d918…, 2026-10-06 12:02Z) committed on chain to
 * `/api/v1/agents/<uuid>/reputation/feedback/1630.json`. A keyless GET of that exact URI answered
 * `401 Unauthorized: API key required`. The bypass and the route both required a UUID event id,
 * repid_events.id is a BIGINT, and every test used a UUID event id, so all of them passed.
 *
 * The second block is the control: the bypass is GET-only and exact-shape.
 */
import { authMiddleware } from '../src/middleware/auth';

jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));

const AGENT = '065ad782-ea58-4078-9414-60a862d67ba1';

async function passesKeyless(method: string, path: string): Promise<boolean> {
  const req: any = { method, path, headers: {}, query: {}, body: {} };
  const res: any = {
    statusCode: 0,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return next.mock.calls.length === 1 && res.statusCode === 0;
}

describe('the feedback file a write committed to is public', () => {
  it('the URI from the first real write (event 1630) passes without a key', async () => {
    expect(await passesKeyless('GET', `/api/v1/agents/${AGENT}/reputation/feedback/1630.json`)).toBe(true);
  });
});

describe('and nothing else rides on that bypass', () => {
  it.each([
    ['a POST to the same path', 'POST', `/api/v1/agents/${AGENT}/reputation/feedback/1630.json`],
    ['a path with a suffix', 'GET', `/api/v1/agents/${AGENT}/reputation/feedback/1630.json/x`],
    ['a non-numeric event id', 'GET', `/api/v1/agents/${AGENT}/reputation/feedback/abc.json`],
    ['an event id with a leading zero', 'GET', `/api/v1/agents/${AGENT}/reputation/feedback/01630.json`],
    ['a traversal in the agent id', 'GET', `/api/v1/agents/../reputation/feedback/1630.json`],
  ])('%s still needs a key', async (_why, method, path) => {
    expect(await passesKeyless(method, path)).toBe(false);
  });
});
