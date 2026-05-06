import request from 'supertest';
import express from 'express';
import { llmRouter } from '../../src/routes/route';
import * as router from '../../src/providers/router';
import { GroqAdapter } from '../../src/providers/groq';
import { AnthropicAdapter } from '../../src/providers/anthropic';
import { RateLimitError } from '../../src/providers/types';

const app = express();
app.use(express.json());
app.use(llmRouter);

describe('LLM Route', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('Successful tier 0 call', async () => {
    const mockAdapter = new GroqAdapter();
    jest.spyOn(mockAdapter, 'complete').mockResolvedValue({
      answer: '4',
      tokensIn: 5,
      tokensOut: 1,
      latencyMs: 100,
      provider: 'groq',
      model: 'test-model'
    });

    jest.spyOn(router, 'routeRequest').mockResolvedValue({
      adapter: mockAdapter,
      decision: { chosen_provider: 'groq', chosen_tier: 0, reason: 'priority_healthy', tried: [] }
    });

    // Mock env var
    process.env.GROQ_API_KEY = 'test-key';

    const res = await request(app)
      .post('/v1/llm/complete')
      .send({ prompt: '2+2' });
    
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('4');
    expect(res.body.provider).toBe('groq');
  });

  it('Tier 0 rate-limited falls to alternate', async () => {
    const groqAdapter = new GroqAdapter();
    const geminiAdapter = new AnthropicAdapter(); // just for mock types
    geminiAdapter.name = 'gemini';
    geminiAdapter.tier = 0;

    let routeCalls = 0;
    jest.spyOn(router, 'routeRequest').mockImplementation(async () => {
      routeCalls++;
      if (routeCalls === 1) {
        return { adapter: groqAdapter, decision: { chosen_provider: 'groq', chosen_tier: 0, reason: 'priority_healthy', tried: [] } };
      }
      return { adapter: geminiAdapter, decision: { chosen_provider: 'gemini', chosen_tier: 0, reason: 'fallback_after_failure', tried: ['groq'] } };
    });

    jest.spyOn(groqAdapter, 'complete').mockRejectedValue(new RateLimitError('Rate limited'));
    jest.spyOn(geminiAdapter, 'complete').mockResolvedValue({
      answer: '4',
      tokensIn: 5,
      tokensOut: 1,
      latencyMs: 100,
      provider: 'gemini',
      model: 'test-model'
    });

    process.env.GROQ_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';

    const res = await request(app)
      .post('/v1/llm/complete')
      .send({ prompt: '2+2' });
    
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(routeCalls).toBe(2);
  });
});
