import request from 'supertest';
import express from 'express';
import { llmRouter } from '../src/routes/route';
import * as router from '../src/providers/router';
import { GroqAdapter } from '../src/providers/groq';
import { db } from '../src/db';

const app = express();
app.use(express.json());
app.use(llmRouter);

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn()
  }
}));

describe('LAO Runtime Orchestration', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('LAO triggers when latency exceeds threshold and folds responses', async () => {
    const mockFrom = db.from as jest.Mock;
    
    mockFrom.mockImplementation((table: string) => {
      if (table === 'repid_config') {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({
            data: [
              { key: 'lao_enabled', value: 'true' },
              { key: 'lao_latency_threshold_ms', value: '50' },
              { key: 'lao_fold_confidence_min', value: '0.80' }
            ],
            error: null
          })
        };
      }
      if (table === 'lao_events') {
        return {
          insert: jest.fn().mockResolvedValue({ data: null, error: null })
        };
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null })
      };
    });

    const mockAdapter = new GroqAdapter();
    let completeCallCount = 0;

    jest.spyOn(mockAdapter, 'complete').mockImplementation(async () => {
      completeCallCount++;
      if (completeCallCount === 1) {
        // Primary agent - slow call (100ms)
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          answer: 'Primary response text',
          tokensIn: 10,
          tokensOut: 20,
          latencyMs: 100,
          provider: 'groq',
          model: 'test-model'
        };
      } else if (completeCallCount === 2) {
        // Engage agent question
        return {
          answer: 'Clarifying question?',
          tokensIn: 5,
          tokensOut: 5,
          latencyMs: 5,
          provider: 'groq',
          model: 'test-model'
        };
      } else if (completeCallCount === 3) {
        // User reply simulation
        return {
          answer: 'User simulated reply',
          tokensIn: 6,
          tokensOut: 6,
          latencyMs: 5,
          provider: 'groq',
          model: 'test-model'
        };
      } else if (completeCallCount === 4) {
        // Refined search
        return {
          answer: 'Refined response text',
          tokensIn: 15,
          tokensOut: 30,
          latencyMs: 10,
          provider: 'groq',
          model: 'test-model'
        };
      } else if (completeCallCount === 5) {
        // Fold evaluator (returns confidence)
        return {
          answer: '0.95',
          tokensIn: 5,
          tokensOut: 2,
          latencyMs: 5,
          provider: 'groq',
          model: 'test-model'
        };
      } else if (completeCallCount === 6) {
        // Fold merge
        return {
          answer: 'Folded final response text',
          tokensIn: 25,
          tokensOut: 40,
          latencyMs: 10,
          provider: 'groq',
          model: 'test-model'
        };
      }
      return { answer: 'default', tokensIn: 0, tokensOut: 0, latencyMs: 0, provider: 'groq', model: 'test' };
    });

    jest.spyOn(router, 'routeRequest').mockResolvedValue({
      adapter: mockAdapter,
      decision: { chosen_provider: 'groq', chosen_tier: '0a', reason: 'priority_healthy', tried: [] }
    });

    process.env.GROQ_API_KEY = 'test-key';

    const res = await request(app)
      .post('/v1/llm/complete')
      .send({ prompt: 'Test LAO prompt' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Folded final response text');
    expect(res.body.tokens_in).toBe(10 + 5 + 6 + 15 + 5 + 25);
    expect(res.body.tokens_out).toBe(20 + 5 + 6 + 30 + 2 + 40);
    expect(completeCallCount).toBe(6);
    expect(mockFrom).toHaveBeenCalledWith('lao_events');
  });
});
