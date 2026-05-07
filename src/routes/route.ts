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
  const healths = getAllHealthStates();
  
  const tier0a = [
    { name: "groq", healthy: healths.groq ? healths.groq.state !== 'down' : true, default_model: "llama-3.1-8b-instant", last_success: healths.groq?.lastSuccess || null },
    { name: "cerebras", healthy: healths.cerebras ? healths.cerebras.state !== 'down' : true, default_model: "llama3.1-8b", last_success: healths.cerebras?.lastSuccess || null },
    { name: "gemini", healthy: healths.gemini ? healths.gemini.state !== 'down' : true, default_model: "gemini-2.0-flash", last_success: healths.gemini?.lastSuccess || null },
    { name: "cohere", healthy: healths.cohere ? healths.cohere.state !== 'down' : true, default_model: "command-r", last_success: healths.cohere?.lastSuccess || null },
    { name: "deepseek", healthy: healths.deepseek ? healths.deepseek.state !== 'down' : true, default_model: "deepseek-chat", last_success: healths.deepseek?.lastSuccess || null }
  ];

  const tier1 = [
    { name: "anthropic", healthy: healths.anthropic ? healths.anthropic.state !== 'down' : true, requires_user_key: true, default_model: "claude-haiku-4-5", last_success: healths.anthropic?.lastSuccess || null },
    { name: "openai", healthy: healths.openai ? healths.openai.state !== 'down' : true, requires_user_key: true, default_model: "gpt-4o-mini", last_success: healths.openai?.lastSuccess || null }
  ];

  res.json({
    tier0a,
    tier1,
    summary: {
      tier0a_healthy: tier0a.filter(p => p.healthy).length,
      tier0a_total: 5,
      tier1_total: 2
    }
  });
});

llmRouter.post('/v1/llm/route-debug', llmLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { prompt, tier_preference = 'auto', task_hint, user_paid_keys } = req.body;
    
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Missing or invalid prompt string' });
      return;
    }

    const routeReq: RouteRequest = {
      prompt,
      tier_preference,
      task_hint,
      user_paid_keys
    };

    const { adapter, decision } = await routeRequest(routeReq, []);
    
    res.json({
      chosen_provider: decision.chosen_provider,
      chosen_tier: decision.chosen_tier,
      reason: decision.reason,
      candidates_tried: decision.tried,
      current_health: getAllHealthStates()
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

llmRouter.post('/v1/llm/complete', llmLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { prompt, tier_preference = 'auto', task_hint, user_paid_keys, max_tokens, temperature } = req.body;
    
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

    // Redact from req.body immediately to ensure downstream error loggers never see it
    if (req.body.user_paid_keys) {
      req.body.user_paid_keys = '[REDACTED]';
    }

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
          tier_used: decision.chosen_tier,
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
