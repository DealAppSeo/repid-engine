import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { routeRequest, RouteRequest } from '../providers/router';
import { markFailure, markSuccess, markRateLimit, getAllHealthStates } from '../providers/health';
import { RateLimitError, AuthError } from '../providers/types';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import { incrementSpend } from '../billing/caps';
import { runScoreEvent, NotFoundError } from '../scoring/pipeline';
import crypto from 'crypto';
import { validateAgentApiKey } from '../auth/api-keys';
import { db } from '../db';

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
  const call_id = crypto.randomUUID();
  try {
    const { prompt, tier_preference = 'auto', task_hint, user_paid_keys, max_tokens, temperature, agent_id, idempotency_key } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Missing or invalid prompt string' });
      return;
    }

    let resolvedAgentId = agent_id;
    const isUuid = (val: any): boolean => {
      if (typeof val !== 'string') return false;
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    };

    if (agent_id && typeof agent_id === 'string' && !isUuid(agent_id)) {
      const lcName = agent_id.toLowerCase();
      const lookupName = lcName.startsWith('trinity-') ? lcName : `trinity-${lcName}`;
      try {
        const { data } = await db
          .from('repid_agents')
          .select('id')
          .eq('agent_name', lookupName)
          .maybeSingle();
        if (data && data.id) {
          resolvedAgentId = data.id;
        }
      } catch (err: any) {
        console.warn(`[route] Failed to resolve agent_id UUID for name "${agent_id}":`, err.message);
      }
    }

    if (resolvedAgentId) {
      const header = req.headers['authorization'];
      const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
      if (!token) {
        res.status(401).json({ error: 'Missing API key for agent_id' });
        return;
      }
      const rawKeys = process.env.REPID_API_KEYS || '';
      const keyList = rawKeys.split(',').map(s => s.trim()).filter(Boolean);
      let isEnvKey = false;
      for (const k of keyList) {
        const [key] = k.split(':');
        if (key === token) {
          isEnvKey = true;
          break;
        }
      }

      // Agent-scoped keys are validated for existence + scope; shared env keys carry no agent binding.
      const validKey = isEnvKey ? null : await validateAgentApiKey(token);
      if (!isEnvKey) {
        if (!validKey) {
          res.status(401).json({ error: 'Invalid or revoked API key' });
          return;
        }
        if (!validKey.scopes.includes('llm_complete')) {
          res.status(403).json({ error: 'Insufficient scopes (missing llm_complete)' });
          return;
        }
      }

      // F2 spoofing fix (2026-06-01): enforce the agent_id binding on EVERY auth path. This check
      // previously lived inside `if (!isEnvKey)`, so any holder of a shared REPID_API_KEYS env key
      // could set agent_id to ANY agent and write score-events/cost/logs under it (impersonation).
      // Now: an agent-scoped key must match its bound agent; a shared env key may NOT target a
      // specific agent_id (it has no agent binding to verify). Callers that don't target a specific
      // agent never enter this block (resolvedAgentId is falsy → unauthenticated service call, unchanged).
      if (validKey) {
        if (validKey.agent_id !== resolvedAgentId) {
          res.status(403).json({ error: 'API key agent_id mismatch' });
          return;
        }
      } else {
        // isEnvKey === true here: a shared env key cannot impersonate a specific agent_id.
        res.status(403).json({ error: 'Shared env key cannot target a specific agent_id' });
        return;
      }
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
      if (adapter.name === 'llama-3-2-1b' || adapter.name === 'gemma-3-2b') {
        apiKey = process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_KEY || process.env.HF_TOKEN || '';
      } else if (adapter.name === 'phi-4') {
        apiKey = process.env.CEREBRAS_API_KEY || '';
      } else if (adapter.tier === 0) {
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

      const startTime = Date.now();
      try {
        const result = await adapter.complete({
          prompt,
          maxTokens: max_tokens,
          temperature,
          apiKey
        });

        const cost_usd = calculateCost(adapter.name, result.model || 'default', result.tokensIn, result.tokensOut);
        
        markSuccess(adapter.name);
        incrementSpend(adapter.name, cost_usd).catch(console.error);

        logLlmCall({
          call_id,
          provider: adapter.name,
          tier: adapter.tier === 0 ? '0a' : '1', // Or chosen_tier
          model: result.model || 'unknown',
          prompt_tokens: result.tokensIn,
          completion_tokens: result.tokensOut,
          cost_usd,
          latency_ms: result.latencyMs,
          status: 'success',
          task_hint,
          agent_id: (resolvedAgentId && isUuid(resolvedAgentId)) ? resolvedAgentId : undefined
        });

        // Write routing decision to anfis_routing_logs (Phase 2.10 / P3)
        try {
          await db.from('anfis_routing_logs').insert({
            request_text: prompt.substring(0, 500),
            selected_model: `${adapter.name}/${result.model || 'default'}`,
            confidence_score: decision.chosen_tier === 'slm' ? 0.9 : 0.7,
            cost_saved: 0,
            latency_ms: result.latencyMs,
            success: true
          });
        } catch (e: any) {
          console.error('[anfis_routing] complete log failure:', e?.message ?? e);
        }

        // Sprint A7 — HAL evaluation + RepID scoring. Only runs when caller
        // supplies agent_id. Score-event failures are logged but never block
        // the LLM response (preserves backward compat for callers that don't
        // care about scoring).
        let hal_evaluation: Record<string, unknown> | null = null;
        if (typeof resolvedAgentId === 'string' && resolvedAgentId.length > 0) {
          try {
            const scoreResult = await runScoreEvent({
              agent_id: resolvedAgentId,
              prompt,
              answer: result.answer,
              provider_used: adapter.name,
              tier_used: String(decision.chosen_tier),
              model_used: result.model || 'unknown',
              llm_call_id: call_id,
              idempotency_key: typeof idempotency_key === 'string' ? idempotency_key : undefined,
            });
            hal_evaluation = {
              score_event_id: scoreResult.score_event_id,
              hal_score: scoreResult.hal_score,
              hal_decision: scoreResult.hal_decision,
              repid_delta: scoreResult.repid_delta_applied,
              new_repid: scoreResult.new_repid,
              zk_proof_triggered: scoreResult.zk_proof_triggered,
            };
          } catch (scoreErr: any) {
            const status = scoreErr instanceof NotFoundError ? 'agent_not_found' : 'score_event_failed';
            console.error(`[llm/complete] ${status}:`, scoreErr?.message ?? scoreErr);
            hal_evaluation = { error: status, message: scoreErr?.message ?? 'unknown' };
          }
        }

        res.json({
          answer: result.answer,
          provider: result.provider,
          tier: adapter.tier,
          tier_used: decision.chosen_tier,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          latency_ms: result.latencyMs,
          cost_estimate_usd: cost_usd,
          router_decision: decision,
          hal_evaluation
        });
        return;

      } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        let status: 'failed' | 'rate_limited' | 'cap_hit' = 'failed';
        if (error instanceof RateLimitError) {
          markRateLimit(adapter.name, error.retryAfterMs || 10000);
          status = 'rate_limited';
        } else if (error instanceof AuthError) {
          markFailure(adapter.name, error);
        } else {
          markFailure(adapter.name, error);
        }
        excludeProviders.push(adapter.name);

        try {
          await db.from('anfis_routing_logs').insert({
            request_text: prompt.substring(0, 500),
            selected_model: `${adapter.name}/unknown`,
            confidence_score: decision?.chosen_tier === 'slm' ? 0.9 : 0.7,
            cost_saved: 0,
            latency_ms: latencyMs,
            success: false
          });
        } catch (e: any) {
          console.error('[anfis_routing] failure log failure:', e?.message ?? e);
        }

        logLlmCall({
          call_id,
          provider: adapter.name,
          tier: adapter.tier === 0 ? '0a' : '1',
          model: 'unknown',
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          latency_ms: latencyMs,
          status,
          error_message: error.message,
          task_hint,
          agent_id: (resolvedAgentId && isUuid(resolvedAgentId)) ? resolvedAgentId : undefined
        });
      }
    }

    res.status(503).json({ error: 'Max routing attempts reached', router_decision: lastDecision });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
