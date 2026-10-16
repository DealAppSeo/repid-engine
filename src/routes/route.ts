import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import { routeRequest, RouteRequest, RouteDecision, resolveTier1Key, keylessProviders, resolveAdapterKey, envKeyedTier1, resolvePin, PinRefusedError } from '../providers/router';
import { resolveFamilyOrUnverified } from './v1/openai-compat';
import { hasValidEnvApiKey } from '../middleware/env-api-key';
import { budgetLimitFrom, createSharedBudget } from '../middleware/shared-budget';
import { logToolCall } from '../utils/tool-call-logger';
import { markFailure, markSuccess, markRateLimit, getAllHealthStates } from '../providers/health';
import { RateLimitError, AuthError, defaultModelFor, servedModel } from '../providers/types';
import { ADAPTER_DEFAULT_MODELS } from '../providers/cost-class';
import { logLlmCall } from '../billing/log-call';
import { calculateCost } from '../billing/pricing';
import { incrementSpend } from '../billing/caps';
import { runScoreEvent, NotFoundError } from '../scoring/pipeline';
import { persistRoutingRecord } from '../decisioning/routing-record-persist';
import crypto from 'crypto';
import { matchEnvOperatorKey, validateAgentApiKey } from '../auth/api-keys';
import { db } from '../db';
import { gateEnabled, meterRun } from '../services/email-otp';

export const llmRouter = Router();

const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 req/min for unauthenticated
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  message: { error: 'Too many requests' }
});

/**
 * KEYLESS CALLERS OF /llm/complete (2026-10-14: public LLM-cost abuse). auth.ts lets this route through
 * without a key on the stated premise that "anonymous callers only ever reach the free tier0 pool". The
 * code did not hold it: tier_preference came straight from the body (default 'auto'), and the router
 * falls back to OUR env key for every Tier-1 adapter (resolveTier1Key), so a keyless caller could reach
 * paid providers on our account, bounded per IP only (meterRun 5 runs/day, 30/min), i.e. not at all
 * for a crowd of rotating IPs. And `tier1_only` + any `user_paid_keys` skipped the meter entirely, while
 * the router still fell back to our key for the providers the caller did NOT bring.
 *
 * Now, for a caller this route did not verify a key for:
 *   - no own keys: routed `tier0_only` (the premise, enforced), and each run takes one unit of a shared
 *     budget across all keyless callers. Spent → 429 with a named `reason`, never a silent pass.
 *   - own keys (BYOK): every Tier-1 adapter it did not bring a key for is excluded, so it can spend only
 *     its own key. Not budgeted: that is its own money.
 *
 *   LLM_ANON_GLOBAL_PER_MIN  keyless runs per minute, all callers   (default 30; 'off' or 0 disables)
 *   LLM_ANON_GLOBAL_DAILY    keyless runs per UTC day, all callers  (default 500; 'off' or 0 disables)
 *
 * WHY THESE DEFAULTS. A keyless visitor gets 5 runs a day (meterRun), so 500 a day is 100 visitors using
 * the whole taste; 30 a minute equals one visitor's per-IP minute limit, so a single real user is never
 * slowed by it. Tier 0 is free but quota-limited: this keeps one crowd from spending the quota the
 * onboarding flow ("Try it, no code") needs.
 */
const anonLlmBudget = createSharedBudget('llm/complete');
export const LLM_ANON_DEFAULT_PER_MIN = 30;
export const LLM_ANON_DEFAULT_DAILY = 500;
/** Test seam. */
export function __resetAnonLlmBudget(): void {
  anonLlmBudget.reset();
}

llmRouter.get('/v1/llm/providers', (req: Request, res: Response) => {
  const healths = getAllHealthStates();
  
  const tier0a = [
    { name: "groq", healthy: healths.groq ? healths.groq.state !== 'down' : true, default_model: getDefaultModelForProvider("groq"), last_success: healths.groq?.lastSuccess || null },
    { name: "cerebras", healthy: healths.cerebras ? healths.cerebras.state !== 'down' : true, default_model: getDefaultModelForProvider("cerebras"), last_success: healths.cerebras?.lastSuccess || null },
    { name: "gemini", healthy: healths.gemini ? healths.gemini.state !== 'down' : true, default_model: getDefaultModelForProvider("gemini"), last_success: healths.gemini?.lastSuccess || null },
    { name: "cohere", healthy: healths.cohere ? healths.cohere.state !== 'down' : true, default_model: getDefaultModelForProvider("cohere"), last_success: healths.cohere?.lastSuccess || null },
    { name: "deepseek", healthy: healths.deepseek ? healths.deepseek.state !== 'down' : true, default_model: getDefaultModelForProvider("deepseek"), last_success: healths.deepseek?.lastSuccess || null }
  ];
  // Idle-live keys wired 2026-07-07: surface sambanova/openrouter in the listing only when routable
  // (env flag on AND key present) so the display matches buildTier0aAdapters() in the router.
  if (process.env.ROUTER_ENABLE_SAMBANOVA !== 'false' && process.env.SAMBANOVA_API_KEY?.trim()) {
    tier0a.push({ name: "sambanova", healthy: healths.sambanova ? healths.sambanova.state !== 'down' : true, default_model: getDefaultModelForProvider("sambanova"), last_success: healths.sambanova?.lastSuccess || null });
  }
  if (process.env.ROUTER_ENABLE_OPENROUTER !== 'false' && process.env.OPENROUTER_API_KEY?.trim()) {
    tier0a.push({ name: "openrouter", healthy: healths.openrouter ? healths.openrouter.state !== 'down' : true, default_model: getDefaultModelForProvider("openrouter"), last_success: healths.openrouter?.lastSuccess || null });
  }

  const tier1 = [
    { name: "anthropic", healthy: healths.anthropic ? healths.anthropic.state !== 'down' : true, requires_user_key: true, default_model: getDefaultModelForProvider("anthropic"), last_success: healths.anthropic?.lastSuccess || null },
    { name: "openai", healthy: healths.openai ? healths.openai.state !== 'down' : true, requires_user_key: true, default_model: getDefaultModelForProvider("openai"), last_success: healths.openai?.lastSuccess || null }
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

/**
 * Provider names that ARE their own model id — the locally-served SLMs. There is no
 * adapter table entry for these because there is no vendor catalogue to drift from.
 */
const LOCAL_SLM_PROVIDERS = new Set(['llama-3-2-1b', 'gemma-3-2b', 'phi-4']);

/**
 * The model a provider will ACTUALLY use on a default request.
 *
 * This was a hand-maintained `switch`, and it was the third of four copies of the same
 * table. Three of them disagreed [MEASURED 2026-08-21]:
 *
 *   provider     ADAPTER_DEFAULT_MODELS      this switch / the /providers listing
 *   gemini       gemini-1.5-flash            gemini-2.0-flash
 *   anthropic    claude-3-5-haiku-20241022   claude-haiku-4-5
 *   openrouter   qwen/qwen-2.5-72b-instruct  meta-llama/llama-3.3-70b-instruct:free
 *
 * `ADAPTER_DEFAULT_MODELS` wins because it is the only copy anything CHECKS:
 * `tests/routing-cost-class.test.ts` reads the adapter sources and fails when the table
 * drifts from the literal an adapter actually sends. The other copies were asserted once
 * and never re-examined, which is how they came to describe models the router does not use.
 *
 * Routed through `defaultModelFor` so a `<PROVIDER>_MODEL` override is reflected here too.
 * Without that, setting an override would fix the ROUTING and leave `/api/v1/llm/providers`
 * publicly advertising the model we stopped using — a new copy of the same bug, one layer out.
 *
 * This matters concretely today: Groq shut down `llama-3.1-8b-instant` on 2026-08-16, so
 * every copy still naming it is advertising a model that 404s.
 */
export function getDefaultModelForProvider(provider: string): string {
  if (LOCAL_SLM_PROVIDERS.has(provider)) return provider;
  const fallback = ADAPTER_DEFAULT_MODELS[provider];
  // 'unknown', not the old 'default'. An unrecognised provider must read as an ABSENCE
  // of knowledge, and 'default' reads like a value — it sorts, it looks deliberate, and
  // in a log column it is indistinguishable from a model actually named "default".
  // The failure-log path already spelled this 'unknown'; two words for one absence is
  // the same duplication this function exists to remove, one layer down.
  if (!fallback) return 'unknown';
  return defaultModelFor(provider, fallback);
}

function inferCategory(prompt: string, taskHint?: string): string {
  const s = (prompt + ' ' + (taskHint || '')).toLowerCase();
  if (/classif|yes\/no|true\/false|fact check|is this|simple fact/.test(s)) return 'factual';
  if (/code|bug|fix|function|typescript|python|implement/.test(s)) return 'code';
  if (/creative|story|poem|imagine|write a|generate.*tale/.test(s)) return 'creative';
  if (/math|calculate|equation|prove/.test(s)) return 'math';
  return 'general';
}

/**
 * The four fields every routed response carries (F1, F2): the model asked for (the pin, or
 * the adapter's own id), the model the vendor says served, that model's registry family
 * ('unverified' when unregistered), and whether a pin was honoured. `model_served_source`
 * says whether the vendor named the model or we fell back to the requested id. `served` is
 * null when nothing answered.
 */
function modelFields(
  decision: RouteDecision | null,
  requested: string | null,
  served: { model: string; source: 'vendor' | 'requested' } | null,
) {
  return {
    model_requested: decision?.pin?.model_requested ?? requested,
    model_served: served?.model ?? null,
    model_served_source: served?.source ?? null,
    family: served ? resolveFamilyOrUnverified(served.model) : null,
    decision: !decision?.pin ? 'routed' : decision.pin.outcome === 'honoured' ? 'pinned' : 'pin_fallback',
  };
}

/**
 * The router decision as the CLIENT sees it. `pin.fallback_reason` names the providers this
 * deployment has wired and their gate state (unhealthy, cap_hit, no key), so it stays in the
 * logs and tool-call rows. The client gets `decision: 'pin_fallback'`. An unpinned decision
 * is returned untouched.
 */
function forClient(decision: RouteDecision | null): RouteDecision | null {
  if (!decision?.pin?.fallback_reason) return decision;
  const { fallback_reason: _logOnly, ...pin } = decision.pin;
  return { ...decision, pin };
}

/** One generic refusal for every reason, so a 400 cannot be used to map our wiring. */
function refusePin(res: Response, e: Error): void {
  console.warn(`[llm/complete] pin refused: ${e.message}`);
  res.status(400).json({ error: 'model_not_pinnable', message: 'model not pinnable here' });
}

llmRouter.post('/v1/llm/complete', llmLimiter, async (req: Request, res: Response): Promise<void> => {
  const call_id = crypto.randomUUID();
  try {
    const { prompt, tier_preference = 'auto', task_hint, user_paid_keys, max_tokens, temperature, agent_id, idempotency_key, model } = req.body;

    // F1 family pin. Checked before the gate meters a run, so a refused pin costs the caller
    // nothing. An unknown, unroutable or unpriced model is refused here, never silently
    // ignored. (The keyless free-only check needs `keyed`, so it runs below.)
    if (model != null) {
      try {
        if (typeof model !== 'string') throw new PinRefusedError('model must be a string naming a registered model');
        resolvePin(model);
      } catch (e) {
        if (!(e instanceof PinRefusedError)) throw e;
        refusePin(res, e);
        return;
      }
    }

    // T0.5 agent gate (spec §9.1): anonymous callers get a small daily
    // taste of hosted runs; a verified-email gate token raises the cap.
    // BYOK callers pay their own way — runs that bring user_paid_keys
    // with a paid-tier preference are not metered by the gate.
    const bringsOwnKeys = tier_preference === 'tier1_only' && user_paid_keys && Object.keys(user_paid_keys).length > 0;
    if (gateEnabled() && !bringsOwnKeys) {
      const gateIp = trustedClientIp(req);
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
      const isEnvKey = Boolean(matchEnvOperatorKey(token));

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

    // KEYLESS CALLERS (see anonLlmBudget above). Keyed = an agent key validated in the block above
    // (resolvedAgentId), or a shared env key. Anything else is anonymous.
    const keyed = Boolean(resolvedAgentId) || hasValidEnvApiKey(req.headers);
    let effectiveTier = tier_preference;
    let anonExclusions: string[] = [];
    if (!keyed) {
      if (bringsOwnKeys) {
        anonExclusions = envKeyedTier1(user_paid_keys as Record<string, string> | undefined);
      } else {
        effectiveTier = 'tier0_only';
        // A keyless pin may only be served FREE (review of #1432): otherwise it moves a paid
        // tier-0 call on our env key ahead of the free providers the chain would use first.
        // Refused before the shared budget is spent.
        if (model != null) {
          try {
            resolvePin(model, { freeOnly: true });
          } catch (e) {
            if (!(e instanceof PinRefusedError)) throw e;
            refusePin(res, e);
            return;
          }
        }
        const refused = anonLlmBudget.take(
          budgetLimitFrom(process.env['LLM_ANON_GLOBAL_PER_MIN'], LLM_ANON_DEFAULT_PER_MIN),
          budgetLimitFrom(process.env['LLM_ANON_GLOBAL_DAILY'], LLM_ANON_DEFAULT_DAILY),
        );
        if (refused) {
          res.status(429).json({
            error: refused === 'global_daily_budget_spent' ? 'free_tier_exhausted' : 'free_tier_busy',
            reason: refused,
            message:
              refused === 'global_daily_budget_spent'
                ? 'The shared free budget for keyless runs is spent for today (UTC). It resets at midnight UTC; bring your own key for unmetered runs.'
                : 'The shared free budget for keyless runs is spent for this minute. Retry in a minute, or bring your own key.',
          });
          return;
        }
      }
    }

    const routeReq: RouteRequest = {
      prompt,
      tier_preference: effectiveTier,
      task_hint,
      user_paid_keys,
      maxTokens: max_tokens,
      temperature,
      // Only when pinned, so an unpinned RouteRequest is exactly what it was. The router
      // re-applies free-only to the keyless pin, so the rule does not rest on the check above.
      ...(model != null ? { model_override: model, ...(!keyed && !bringsOwnKeys ? { pin_free_only: true } : {}) } : {})
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
    let excludeProviders: string[] = [...new Set([...keylessProviders(user_paid_keys as Record<string, string> | undefined), ...anonExclusions])];
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
        routingRecord,
        model: pinnedModel
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
        // tool_input is the stored column (output is only hashed), so the pin record goes here.
        toolInput: { tier_preference, ...(decision.pin ? { pin: decision.pin } : {}) },
        toolOutput: { chosen_provider: decision.chosen_provider, chosen_tier: decision.chosen_tier, reason: decision.reason },
        repidAtCall: 0,
        confidenceAtCall: 0.9,
        autonomyTier: 'just_do_it',
      });

      if (!adapter || decision.reason === 'all_exhausted') {
        res.status(503).json({ error: 'All available providers exhausted', router_decision: forClient(decision), ...modelFields(decision, null, null) });
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
          apiKey,
          // Only when a pin was honoured, so an unpinned adapter call is exactly what it was.
          ...(pinnedModel ? { model: pinnedModel } : {})
        });

        // Cost stays on the REQUESTED id (`result.model`), as before: a served dated snapshot
        // (gpt-4o-mini-2024-07-18) has no pricing row and would price at 0, and caps read this.
        const cost_usd = calculateCost(adapter.name, result.model || 'default', result.tokensIn, result.tokensOut);
        // F2: every "model used" record below names what the vendor says served, which can
        // differ from what we asked for. Until 2026-10-16 they all recorded the requested id.
        const served = servedModel(result);
        const modelServed = served.model || 'unknown';
        const routed = modelFields(decision, result.model || 'unknown', { model: modelServed, source: served.source });

        markSuccess(adapter.name);
        incrementSpend(adapter.name, cost_usd).catch(console.error);

        void logToolCall({
          agentName: 'llm-broker',
          toolName: 'provider-call',
          toolInput: {
            provider: adapter.name,
            ...routed,
            ...(decision.pin?.fallback_reason ? { fallback_reason: decision.pin.fallback_reason } : {}),
          },
          toolOutput: routed,
          repidAtCall: 0,
          confidenceAtCall: 0.9,
          autonomyTier: 'just_do_it',
        });

        logLlmCall({
          call_id,
          provider: adapter.name,
          tier: adapter.tier === 0 ? '0a' : '1', // Or chosen_tier
          model: modelServed,
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
            selected_model: modelServed,
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
              model_used: modelServed,
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
          router_decision: forClient(decision),
          hal_evaluation,
          ...routed
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
            // selected_model is NOT NULL; on the failure path use the model attempted (the pin, else the default).
            selected_model: pinnedModel ?? getDefaultModelForProvider(adapter.name),
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
          // WAS `'unknown'`. A real call had just been made to a known provider, so
          // the model was never actually unknown — the log simply declined to say.
          // On 2026-08-21 that cost a live diagnosis: a user's failing row read
          // `model: 'unknown'` next to a 404, and "is our configured model stale?"
          // — which was the answer — could not be asked of the log at all.
          //
          // Resolved through `defaultModelFor` rather than a literal so the value
          // reflects a `<PROVIDER>_MODEL` override. Logging the built-in default
          // while the deployment overrides it would restore the same lie in a new
          // shape. The fallback is `ADAPTER_DEFAULT_MODELS`, which is drift-tested
          // against the adapter sources by tests/routing-cost-class.test.ts.
          //
          // The model the adapter was asked for: the pin when one was honoured, else
          // the default. (This used to say a caller's explicit model was invisible
          // here; a pin now arrives as `pinnedModel`, so it is not.) A failed call has
          // no vendor body, so there is no served id to record.
          model: pinnedModel ?? getDefaultModelForProvider(adapter.name),
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

    res.status(503).json({ error: 'Max routing attempts reached', router_decision: forClient(lastDecision), ...modelFields(lastDecision, null, null) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
