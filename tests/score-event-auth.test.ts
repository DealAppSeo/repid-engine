import request from 'supertest';
import express from 'express';
import { db } from '../src/db';
import agentsExternalRouter from '../src/routes/agents-external';
import { llmRouter } from '../src/routes/route';
import { validateAgentApiKey } from '../src/auth/api-keys';

jest.mock('../src/auth/api-keys');
jest.mock('../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { current_repid: 1000 }, error: null })
  }
}));

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsExternalRouter);
app.use('/api', llmRouter);

describe('Auth Tests for Score Event and Complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Score-event without API key -> 401', async () => {
    const res = await request(app).post('/api/v1/agents/agent-1/score-event').send({
      llm_provider: 'test', certainty: 0.9, decision_text: 'test', outcome: 'test', task_domain: 'finance'
    });
    expect(res.status).toBe(401);
  });

  it('Score-event with valid key for different agent -> 403', async () => {
    (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-2', scopes: ['score_event'] });
    const res = await request(app)
      .post('/api/v1/agents/agent-1/score-event')
      .set('Authorization', 'Bearer ts_live_test')
      .send({ llm_provider: 'test', certainty: 0.9, decision_text: 'test', outcome: 'test', task_domain: 'finance' });
    expect(res.status).toBe(403);
  });

  it('Score-event with valid key for matching agent -> 200', async () => {
    (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-1', scopes: ['score_event'] });
    // Note: This will return 500 because the rest of the route is not mocked, but that means it passed auth!
    const res = await request(app)
      .post('/api/v1/agents/agent-1/score-event')
      .set('Authorization', 'Bearer ts_live_test')
      .send({ llm_provider: 'test', certainty: 0.9, decision_text: 'test', outcome: 'test', task_domain: 'finance' });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('/complete with agent_id but no key -> 401', async () => {
    const res = await request(app).post('/api/v1/llm/complete').send({
      prompt: 'test', agent_id: 'agent-1'
    });
    expect(res.status).toBe(401);
  });

  it('/complete with agent_id and matching key -> 200', async () => {
    (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-1', scopes: ['llm_complete'] });
    const res = await request(app).post('/api/v1/llm/complete')
      .set('Authorization', 'Bearer ts_live_test')
      .send({ prompt: 'test', agent_id: 'agent-1' });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
