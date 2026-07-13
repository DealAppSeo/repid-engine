import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { routeRequest, RouteRequest, resolveTier1Key } from '../providers/router';
import { logToolCall } from '../utils/tool-call-logger';
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
  // Idle-live keys wired 2026-07-07: surface sambanova/openrouter in the listing only when routable
  // (env flag on AND key present) so the display matches buildTier0aAdapters() in the router.
  if (process.env.ROUTER_ENABLE_SAMBANOVA !== 'false' && process.env.SAMBANOVA_API_KEY?.trim()) {
    tier0a.push({ name: "sambanova", healthy: healths.sambanova ? healths.sambanova.state !== 'down' : true, default_model: "Meta-Llama-3.1-8B-Instruct", last_success: healths.sambanova?.lastSuccess || null });
  }
  if (process.env.ROUTER_ENABLE_OPENROUTER !== 'false' && process.env.OPENROUTER_API_KEY?.trim()) {
    tier0a.push({ name: "openrouter", healthy: healths.openrouter ? healths.openrouter.state !== 'down' : true, default_model: "meta-llama/llama-3.3-70b-instruct:free", last_success: healths.openrouter?.lastSuccess || null });
  }

  const tier1 = [
    { name: "anthropic", healthy: healths.anthropic ? healths.anthropic.state !== 'down' : true, requires_user_key: true, default_model: "claude-haiku-4-5", last_success: healths.anthropic?.lastSuccess || null },
    { name: "openai", healthy: healths.openai ? healths.openai.state !== 'down' : true, requires_user_key: true, default_model: "gpt-4o-mini", last_success: healths.openai?.lastSuccess || null }
  ];

  res.json({
    tier0a,
    tier1,
    summary: {
      tier0a_healthy: tier0a.filter(p => p.healthy).length,
      tier0a_total: tier0a.length,
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

function getDefaultModelForProvider(provider: string): string {
  switch (provider) {
    case 'groq': return 'llama-3.1-8b-instant';
    case 'cerebras': return 'llama3.1-8b';
    case 'gemini': return 'gemini-2.0-flash';
    case 'cohere': return 'command-r';
    case 'deepseek': return 'deepseek-chat';
    case 'anthropic': return 'claude-haiku-4-5';
    case 'openai': return 'gpt-4o-mini';
    case 'llama-3-2-1b': return 'llama-3-2-1b';
    case 'gemma-3-2b': return 'gemma-3-2b';
    case 'phi-4': return 'phi-4';
    default: return 'default';
  }
}

function inferCategory(prompt: string, taskHint?: string): string {
  const s = (prompt + ' ' + (taskHint || '')).toLowerCase();
  if (/classif|yes\/no|true\/false|fact check|is this|simple fact/.test(s)) return 'factual';
  if (/code|bug|fix|function|typescript|python|implement/.test(s)) return 'code';
  if (/creative|story|poem|imagine|write a|generate.*tale/.test(s)) return 'creative';
  if (/math|calculate|equation|prove/.test(s)) return 'math';
  return 'general';
}

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
      
      const {
        adapter,
        decision,
        staticProvider,
        staticTier,
        anfisProvider,
        anfisTier,
        anfisConfidence
      } = await routeRequest(routeReq, excludeProviders);
      lastDecision = decision;
      // S-HARDEN Phase 3 — audit the ANFIS routing decision (gated by TOOL_CALL_LOGGING; no-op default; never throws).
      void logToolCall({
        agentName: 'anfis-router',
        toolName: 'provider-selection',
        toolInput: { tier_preference },
        toolOutput: { chosen_provider: decision.chosen_provider, chosen_tier: decision.chosen_tier, reason: decision.reason },
        repidAtCall: 0,
        confidenceAtCall: 0.9,
        autonomyTier: 'just_do_it',
      });

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
        // Tier-1: prefer caller's user_paid_keys; fall back to deployed env key
        // (ANTHROPIC_API_KEY / OPENAI_API_KEY) so tier1_only works without a caller key.
        apiKey = resolveTier1Key(adapter.name, user_paid_keys) || '';
      }

      if (!apiKey) {
        markFailure(adapter.name, new AuthError(`No key found for ${adapter.name}`));
        excludeProviders.push(adapter.name);
        continue;
      }

      const startTime = Date.now();
      try {
        const result = await runLaoOrchestration(
          adapter,
          prompt,
          max_tokens,
          temperature,
          apiKey
        );

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

        // Write routing decision to anfis_routing_logs (PHASE1 fix: both picks + REAL delta from ledger+tokens on success path; full schema for mig+types+ DONE-CHECK cost_saved<>0 + array_length(verified_by)>=2)
        // Cite: migrations/2026-06-05-anfis-routing-logs.sql (CREATE+ALTER cost_saved/verified_by), src/types/database.types.ts:9912, src/providers/router.ts:121 (anfisRec), calculateCost, inferCategory.
        try {
          const staticModel = getDefaultModelForProvider(staticProvider);
          const anfisModel = getDefaultModelForProvider(anfisProvider);
          const staticCost = calculateCost(staticProvider, staticModel, result.tokensIn, result.tokensOut);
          const anfisCost = calculateCost(anfisProvider, anfisModel, result.tokensIn, result.tokensOut);
          const cost_saved = staticCost - anfisCost;
          const cat = inferCategory(prompt, task_hint);

          await db.from('anfis_routing_logs').insert({
            prompt_preview: prompt.substring(0, 200),
            category: cat,
            // selected_model is NOT NULL in the table; omitting it silently failed every insert
            // (the success-path logger had written 0 rows). Record the model actually used.
            selected_model: result.model || getDefaultModelForProvider(adapter.name),
            static_provider: staticProvider,
            static_tier: staticTier,
            static_reason: 'static',
            anfis_provider: anfisProvider,
            anfis_tier: anfisTier,
            anfis_conf: anfisConfidence,
            cost_usdc: cost_saved,
            cost_saved,
            latency_ms: result.latencyMs,
            success: true,
            verified_by: [`static:${staticProvider}:${staticTier}`, `anfis:${anfisProvider}:${anfisTier}`],
            request_text: prompt.substring(0, 500)
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
          // PHASE1 fix: compute real counterfactual delta even on failure (est tokens from prompt len for differential; was 0,0). Both picks in verified_by always. Full schema.
          // Cite: same as success block + SPRINT_XC_2026-06-05.md PHASE1.
          const estIn = Math.max(8, Math.floor(prompt.length / 3.5));
          const estOut = 48;
          const staticModel = getDefaultModelForProvider(staticProvider);
          const anfisModel = getDefaultModelForProvider(anfisProvider);
          const staticCost = calculateCost(staticProvider, staticModel, estIn, estOut);
          const anfisCost = calculateCost(anfisProvider, anfisModel, estIn, estOut);
          const cost_saved = staticCost - anfisCost;
          const cat = inferCategory(prompt, task_hint);
          await db.from('anfis_routing_logs').insert({
            prompt_preview: prompt.substring(0, 200),
            category: cat,
            // selected_model is NOT NULL; on the failure path use the attempted provider's default model.
            selected_model: getDefaultModelForProvider(adapter.name),
            static_provider: staticProvider,
            static_tier: staticTier,
            static_reason: 'static',
            anfis_provider: anfisProvider,
            anfis_tier: anfisTier,
            anfis_conf: anfisConfidence,
            cost_usdc: cost_saved,
            cost_saved,
            latency_ms: latencyMs,
            success: false,
            verified_by: [`static:${staticProvider}:${staticTier}`, `anfis:${anfisProvider}:${anfisTier}`],
            request_text: prompt.substring(0, 500)
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

interface LaoConfig {
  laoEnabled: boolean;
  laoLatencyThresholdMs: number;
  laoFoldConfidenceMin: number;
}

let laoConfigCache: { config: LaoConfig; fetchedAt: number } | null = null;

async function getLaoConfig(): Promise<LaoConfig> {
  const now = Date.now();
  if (laoConfigCache && now - laoConfigCache.fetchedAt < 15000) {
    return laoConfigCache.config;
  }

  try {
    const { data } = await db
      .from('repid_config')
      .select('key, value')
      .in('key', ['lao_enabled', 'lao_latency_threshold_ms', 'lao_fold_confidence_min']);

    const config: LaoConfig = {
      laoEnabled: false,
      laoLatencyThresholdMs: 3000,
      laoFoldConfidenceMin: 0.80,
    };

    if (data) {
      for (const row of data) {
        if (row.key === 'lao_enabled') {
          config.laoEnabled = row.value === 'true' || row.value === '1';
        } else if (row.key === 'lao_latency_threshold_ms') {
          const val = parseInt(row.value);
          if (!isNaN(val)) config.laoLatencyThresholdMs = val;
        } else if (row.key === 'lao_fold_confidence_min') {
          const val = parseFloat(row.value);
          if (!isNaN(val)) config.laoFoldConfidenceMin = val;
        }
      }
    }

    laoConfigCache = { config, fetchedAt: now };
    return config;
  } catch (err) {
    console.error('[LAO] Failed to fetch config, using defaults:', err);
    return {
      laoEnabled: false,
      laoLatencyThresholdMs: 3000,
      laoFoldConfidenceMin: 0.80,
    };
  }
}

interface LlmCompleteResult {
  answer: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  provider: string;
  model: string;
}

async function runLaoOrchestration(
  adapter: any,
  prompt: string,
  maxTokens: number | undefined,
  temperature: number | undefined,
  apiKey: string,
): Promise<LlmCompleteResult> {
  const config = await getLaoConfig();

  if (!config.laoEnabled) {
    const start = Date.now();
    const result = await adapter.complete({ prompt, maxTokens, temperature, apiKey });
    return {
      answer: result.answer,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: Date.now() - start,
      provider: result.provider || adapter.name,
      model: result.model || 'unknown',
    };
  }

  const startTime = Date.now();
  let primaryDone = false;
  let primaryResult: any = null;

  const primaryPromise = adapter.complete({ prompt, maxTokens, temperature, apiKey })
    .then((res: any) => {
      primaryDone = true;
      primaryResult = res;
      return { type: 'primary', res };
    });

  const timerPromise = new Promise((resolve) => setTimeout(resolve, config.laoLatencyThresholdMs))
    .then(() => ({ type: 'timer' }));

  const winner = await Promise.race([primaryPromise, timerPromise]);

  if (winner.type === 'primary') {
    const res = winner.res;
    return {
      answer: res.answer,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs: Date.now() - startTime,
      provider: res.provider || adapter.name,
      model: res.model || 'unknown',
    };
  }

  console.log(`[LAO] Latency crossed threshold of ${config.laoLatencyThresholdMs}ms. Orchestrating two-agent flow.`);

  let totalTokensIn = 0;
  let totalTokensOut = 0;

  const engagePrompt = `The primary search is taking longer than expected. Based on the user's prompt: "${prompt}", ask a single relevant qualifying or clarifying question to refine their intent, get fresh details, or specify scope. Keep it concise, natural, and helpful. Do not mention any technical details or that you are waiting.`;
  
  let engageQuestion = '';
  try {
    const engageResult = await adapter.complete({ prompt: engagePrompt, maxTokens: 100, temperature: 0.7, apiKey });
    engageQuestion = engageResult.answer;
    totalTokensIn += engageResult.tokensIn;
    totalTokensOut += engageResult.tokensOut;
  } catch (err) {
    console.error('[LAO] Engage question generation failed:', err);
    engageQuestion = 'Could you clarify if you need a quick summary or a detailed breakdown?';
  }

  const userSimPrompt = `You are a user who wrote the prompt: "${prompt}". An AI assistant asks you the clarifying question: "${engageQuestion}". Provide a natural, concise, helpful reply answering their question.`;
  let userRepliedText = '';
  try {
    const userSimResult = await adapter.complete({ prompt: userSimPrompt, maxTokens: 100, temperature: 0.7, apiKey });
    userRepliedText = userSimResult.answer;
    totalTokensIn += userSimResult.tokensIn;
    totalTokensOut += userSimResult.tokensOut;
  } catch (err) {
    console.error('[LAO] User reply simulation failed:', err);
    userRepliedText = 'A comprehensive breakdown, please.';
  }

  const refinedPrompt = `Original request: "${prompt}"\nUser clarification: "${userRepliedText}"\nPlease provide the final, refined, highly accurate response.`;
  const refinedPromise = adapter.complete({ prompt: refinedPrompt, maxTokens, temperature, apiKey });

  let refinedResult: any = null;
  try {
    const [pRes, rRes] = await Promise.all([primaryPromise, refinedPromise]);
    primaryResult = pRes.res;
    refinedResult = rRes;
    totalTokensIn += primaryResult.tokensIn + refinedResult.tokensIn;
    totalTokensOut += primaryResult.tokensOut + refinedResult.tokensOut;
  } catch (err) {
    console.error('[LAO] Parallel searches failed, falling back to primary:', err);
    primaryResult = await primaryPromise.then((x: any) => x.res);
    return {
      answer: primaryResult.answer,
      tokensIn: primaryResult.tokensIn + totalTokensIn,
      tokensOut: primaryResult.tokensOut + totalTokensOut,
      latencyMs: Date.now() - startTime,
      provider: primaryResult.provider || adapter.name,
      model: primaryResult.model || 'unknown',
    };
  }

  const evaluatorPrompt = `Evaluate the following two answers to the prompt: "${prompt}"\nPrimary Answer: "${primaryResult.answer}"\nRefined Answer: "${refinedResult.answer}"\nProvide a score between 0.0 and 1.0 representing your confidence in their combined accuracy and intent alignment. Return ONLY the number (e.g., 0.85).`;
  let foldConfidence = 0.85;
  try {
    const evalResult = await adapter.complete({ prompt: evaluatorPrompt, maxTokens: 10, temperature: 0.0, apiKey });
    const parsed = parseFloat(evalResult.answer.trim());
    if (!isNaN(parsed)) foldConfidence = parsed;
    totalTokensIn += evalResult.tokensIn;
    totalTokensOut += evalResult.tokensOut;
  } catch (err) {
    console.error('[LAO] Confidence evaluation failed:', err);
  }

  let finalFoldedText = '';
  if (foldConfidence >= config.laoFoldConfidenceMin) {
    const foldPrompt = `Merge and compile the following two responses into a single, cohesive, high-quality final answer:\nResponse 1: "${primaryResult.answer}"\nResponse 2: "${refinedResult.answer}"`;
    try {
      const foldResult = await adapter.complete({ prompt: foldPrompt, maxTokens, temperature, apiKey });
      finalFoldedText = foldResult.answer;
      totalTokensIn += foldResult.tokensIn;
      totalTokensOut += foldResult.tokensOut;
    } catch (err) {
      console.error('[LAO] Answer folding failed, using refined answer:', err);
      finalFoldedText = refinedResult.answer;
    }
  } else {
    finalFoldedText = primaryResult.answer;
  }

  const finalLatencyMs = Date.now() - startTime;

  try {
    await db.from('lao_events').insert({
      trigger_latency_ms: finalLatencyMs,
      engage_question: engageQuestion,
      user_replied: userRepliedText,
      fold_confidence: foldConfidence,
      final_folded: finalFoldedText,
    });
  } catch (dbErr) {
    console.error('[LAO] Failed to log telemetry to lao_events:', dbErr);
  }

  return {
    answer: finalFoldedText,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    latencyMs: finalLatencyMs,
    provider: primaryResult.provider || adapter.name,
    model: primaryResult.model || 'unknown',
  };
}
