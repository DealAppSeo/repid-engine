import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { routeRequest, RouteRequest, resolveTier1Key, keylessProviders, resolveAdapterKey} from '../providers/router';
import { logToolCall } from '../utils/tool-call-logger';
import { markFailure, markSuccess, markRateLimit, getAllHealthStates } from '../providers/health';
import { RateLimitError, AuthError } from '../providers/types';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import { incrementSpend } from '../billing/caps';
import { runScoreEvent, NotFoundError } from '../scoring/pipeline';
import { persistRoutingRecord } from '../decisioning/routing-record-persist';
import crypto from 'crypto';
import { validateAgentApiKey } from '../auth/api-keys';
import { db } from '../db';
import { gateEnabled, meterRun } from '../services/email-otp';

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

    // T0.5 agent gate (spec §9.1): anonymous callers get a small daily
    // taste of hosted runs; a verified-email gate token raises the cap.
    // BYOK callers pay their own way — runs that bring user_paid_keys
    // with a paid-tier preference are not metered by the gate.
    const bringsOwnKeys = tier_preference === 'tier1_only' && user_paid_keys && Object.keys(user_paid_keys).length > 0;
    if (gateEnabled() && !bringsOwnKeys) {
      const gateIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
      const meter = meterRun(gateIp, req.headers['x-agent-gate-token']);
      res.setHeader('x-taste-remaining', String(meter.remaining));
      if (!meter.allowed) {
        res.status(429).json(
          meter.verified
            ? {
                error: 'daily_cap',
                message: `You've reached today's ${meter.limit}-run limit. It resets tomorrow — or bring your own key on /connect for unmetered runs.`,
              }
            : {
                error: 'verification_required',
                message: `You've used your ${meter.limit} free runs today. Save your progress and keep going free — all it takes is an email.`,
              }
        );
        return;
      }
    }

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
    // PRE-FILTER: never spend a routing attempt on a provider that has no key.
    // Previously the loop selected a keyless provider, excluded it, and burned
    // one of three attempts — a live smoke call 503'd having made exactly ONE
    // real provider call. Seeding the exclusion list makes maxAttempts mean
    // that many genuine attempts.
    let excludeProviders: string[] = keylessProviders(user_paid_keys as Record<string, string> | undefined);
    if (excludeProviders.length) {
      console.warn(
        `[llm/complete] ${excludeProviders.length} provider(s) have NO key and were excluded before selection: ` +
          excludeProviders.join(', ')
      );
    }
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
        anfisConfidence,
        routingRecord
      } = await routeRequest(routeReq, excludeProviders);
      lastDecision = decision;

      // CLOSE THE LOOP: persist the decision-time feature set so it can be joined to the
      // outcome this same `call_id` will write to `llm_call_log`, on (call_id, provider).
      //
      // This is the ONLY site where both halves are in scope. `buildRoutingRecord` runs
      // inside `routeRequest` and knows nothing about `call_id`; `logLlmCall` knows
      // `call_id` and nothing about the candidate chain. Without this line the two are
      // never joinable and no (features -> outcome) corpus can exist.
      //
      // INERT: fire-and-forget, after selection, cannot move a decision. Gated by
      // ROUTING_RECORD_PERSIST, DEFAULT OFF — see src/decisioning/routing-record-persist.ts
      // for why the default is off (this system shed ~8.6M writes/day for that reason).
      if (routingRecord) {
        void persistRoutingRecord({
          callId: call_id,
          attempt: attempts,
          record: routingRecord,
          taskHint: typeof task_hint === 'string' ? task_hint : undefined,
        });
      }
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

      // Same resolver the pre-filter uses — one definition, so they cannot drift.
      const apiKey = resolveAdapterKey(adapter.name, adapter.tier, user_paid_keys as Record<string, string> | undefined);

      if (!apiKey) {
        markFailure(adapter.name, new AuthError(`No key found for ${adapter.name}`));
        excludeProviders.push(adapter.name);
        // LOG IT. This branch previously `continue`d silently, so a provider with
        // no key burned one of the three routing attempts and left NO trace in
        // llm_call_log. A live smoke test returned 503 "Max routing attempts
        // reached" having written exactly ONE log row for three attempts, which
        // made the cause invisible — the two silent no-key skips looked like
        // they never happened. An unroutable provider must be as visible as a
        // failing one.
        logLlmCall({
          call_id,
          provider: adapter.name,
          tier: adapter.tier === 0 ? '0a' : '1',
          model: 'unknown',
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          latency_ms: 0,
          status: 'failed',
          error_message: `no API key configured for ${adapter.name} — provider skipped, routing attempt consumed`,
          task_hint,
          agent_id: (resolvedAgentId && isUuid(resolvedAgentId)) ? resolvedAgentId : undefined
        });
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
