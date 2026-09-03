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

// The route walks the provider chain, and every hop consults `checkCap`, which is a
// live Supabase SELECT. Unmocked, `/route-debug` hung until jest's 5s timeout while
// `/providers` (which does no cap lookup) passed — one green and one red in the same
// file, from the same cause. `checkCap` fails OPEN on error, so this suite's verdict
// tracked network conditions rather than routing logic. See the header of
// providers/__tests__/router.tiered.test.ts for the full account.
jest.mock('../../db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    single: async () => ({ data: null, error: { message: 'no cap row (mocked)' } }),
  };
  return { db: { from: () => chain } };
});

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
