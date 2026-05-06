import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { routeRequest, RouteRequest } from '../providers/router';
import { markFailure, markSuccess, markRateLimit, getAllHealthStates } from '../providers/health';
import { RateLimitError, AuthError } from '../providers/types';

export const llmRouter = Router();

const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 req/min for unauthenticated
  message: { error: 'Too many requests' }
});

llmRouter.get('/v1/llm/providers', (req: Request, res: Response) => {
  res.json(getAllHealthStates());
});

llmRouter.post('/v1/llm/complete', llmLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { prompt, tier_preference = 'tier0_first', task_hint, user_paid_keys, max_tokens, temperature } = req.body;
    
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Missing or invalid prompt string' });
      return;
    }

    const routeReq: RouteRequest = {
      prompt,
      tier_preference,
      task_hint,
      user_paid_keys,
      maxTokens: max_tokens,
      temperature
    };

    let attempts = 0;
    const maxAttempts = 3;
    let excludeProviders: string[] = [];
    let lastDecision: any = null;

    while (attempts < maxAttempts) {
      attempts++;
      
      const { adapter, decision } = await routeRequest(routeReq, excludeProviders);
      lastDecision = decision;

      if (!adapter || decision.reason === 'all_exhausted') {
        res.status(503).json({ error: 'All available providers exhausted', router_decision: decision });
        return;
      }

      let apiKey = '';
      if (adapter.tier === 0) {
        const envKey = `${adapter.name.toUpperCase()}_API_KEY`;
        apiKey = process.env[envKey] || '';
      } else {
        apiKey = (user_paid_keys as any)?.[adapter.name] || '';
      }

      if (!apiKey) {
        markFailure(adapter.name, new AuthError(`No key found for ${adapter.name}`));
        excludeProviders.push(adapter.name);
        continue;
      }

      try {
        const result = await adapter.complete({
          prompt,
          maxTokens: max_tokens,
          temperature,
          apiKey
        });

        markSuccess(adapter.name);

        res.json({
          answer: result.answer,
          provider: result.provider,
          tier: adapter.tier,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          latency_ms: result.latencyMs,
          cost_estimate_usd: adapter.tier === 0 ? 0 : 0.001,
          router_decision: decision
        });
        return;

      } catch (error: any) {
        if (error instanceof RateLimitError) {
          markRateLimit(adapter.name, error.retryAfterMs || 10000);
          excludeProviders.push(adapter.name);
        } else if (error instanceof AuthError) {
          markFailure(adapter.name, error);
          excludeProviders.push(adapter.name);
        } else {
          markFailure(adapter.name, error);
          excludeProviders.push(adapter.name);
        }
      }
    }

    res.status(503).json({ error: 'Max routing attempts reached', router_decision: lastDecision });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
