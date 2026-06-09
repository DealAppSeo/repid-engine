/**
 * F2-authz invariant (b): a shared REPID_API_KEYS env key has NO agent binding, so it must NOT be
 * able to target a SPECIFIC agent_id — route.ts must reject it with 403. This complements GA's
 * score-event-auth test (invariant a: an agent-scoped key whose agent_id ≠ target → 403).
 *
 * Behavioral proof — exercises the real llmRouter auth block, not a regex.
 */
import request from 'supertest';
import express from 'express';
import { llmRouter } from '../src/routes/route';
import { validateAgentApiKey } from '../src/auth/api-keys';

jest.mock('../src/auth/api-keys');
jest.mock('../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { current_repid: 1000 }, error: null }),
  },
}));

const app = express();
app.use(express.json());
app.use('/api', llmRouter);

describe('F2-authz: shared env key cannot target a specific agent', () => {
  const prevKeys = process.env.REPID_API_KEYS;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REPID_API_KEYS = 'envshared:pro'; // token "envshared" is a shared env key (no agent binding)
  });
  afterAll(() => { if (prevKeys === undefined) delete process.env.REPID_API_KEYS; else process.env.REPID_API_KEYS = prevKeys; });

  it('shared env key + specific agent_id -> 403 (cannot impersonate an agent)', async () => {
    // isEnvKey=true → validKey is null → the agent-id-binding branch must reject (403).
    const res = await request(app)
      .post('/api/v1/llm/complete')
      .set('Authorization', 'Bearer envshared')
      .send({ prompt: 'test', agent_id: 'agent-1' });
    expect(res.status).toBe(403);
  });

  it('agent-scoped key whose agent_id != target -> 403 (regression guard for invariant a on /complete)', async () => {
    (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-2', scopes: ['llm_complete'] });
    const res = await request(app)
      .post('/api/v1/llm/complete')
      .set('Authorization', 'Bearer ts_live_agentkey')
      .send({ prompt: 'test', agent_id: 'agent-1' });
    expect(res.status).toBe(403);
  });
});
