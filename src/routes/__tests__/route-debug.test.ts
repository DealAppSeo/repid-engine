import request from 'supertest';
import express from 'express';
import { llmRouter } from '../route';
import { isHealthy, getAllHealthStates } from '../../providers/health';

jest.mock('../../providers/health', () => ({
  isHealthy: jest.fn().mockReturnValue(true),
  getAllHealthStates: jest.fn().mockReturnValue({}),
  markFailure: jest.fn(),
  markSuccess: jest.fn(),
  markRateLimit: jest.fn()
}));

const app = express();
app.use(express.json());
app.use(llmRouter);

describe('GET /providers and POST /route-debug', () => {
  it('returns providers JSON', async () => {
    const res = await request(app).get('/v1/llm/providers');
    expect(res.status).toBe(200);
    expect(res.body.tier0a).toBeDefined();
    expect(res.body.tier1).toBeDefined();
    expect(res.body.summary).toBeDefined();
  });

  it('returns route debug decision', async () => {
    const res = await request(app).post('/v1/llm/route-debug').send({
      prompt: 'test',
      tier_preference: 'auto'
    });
    expect(res.status).toBe(200);
    expect(res.body.chosen_provider).toBe('groq');
    expect(res.body.chosen_tier).toBe('0a');
  });
});
