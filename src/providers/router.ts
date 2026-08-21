import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';
import { GroqAdapter } from './groq';
import { GeminiAdapter } from './gemini';
import { CerebrasAdapter } from './cerebras';
import { ZaiAdapter } from './zai';
import { DeepSeekAdapter } from './deepseek';
import { CohereAdapter } from './cohere';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
import { OpenRouterAdapter } from './openrouter';
import { SambaNovaAdapter } from './sambanova';
import { Llama321bAdapter, Gemma32bAdapter, Phi4Adapter } from './slm';
import { isHealthy, markFailure, markSuccess, markRateLimit } from './health';
import { deadProviders, livenessMode } from './provider-liveness';
import { checkCap } from '../billing/caps';
import { db } from '../db';
import { computeShadowDecision, anfisRecommendProvider } from '../services/anfis-router'; // A2 shadow for TRACK A (ANFIS/LASSO rebuild)
import { applyEscalationOnly } from '../services/anfis-escalation-gate'; // 2026-07-30 bounded live authority (PR #281)
import { persistShadowDecision } from '../services/anfis-shadow-persist'; // persist shadow decision so ANFIS is measurable (shadow-only, no routing change)
import { operationalCostClass, declaredFree, defaultBlendedPrice } from './cost-class';
import { buildRoutingRecord, summarizeRoutingRecord, RoutingRecord } from '../decisioning/routing-record';

export interface RouteRequest {
  prompt: string;
  tier_preference: 'tier0_only' | 'tier0_first' | 'tier1_only' | 'auto';
  user_paid_keys?: { openai?: string; anthropic?: string };
  task_hint?: string;
  model_override?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RouteDecision {
  chosen_provider: string;
  chosen_tier: '0a' | '1' | 'none' | 'slm';
  reason: 'priority_healthy' | 'fallback_after_failure' | 'tier1_required' | 'all_exhausted' | 'cap_hit' | 'slm_low_complexity' | 'anfis_escalation' | 'anfis_lateral';
  tried: string[];
}

const slmAdapters: ProviderAdapter[] = [
  new Llama321bAdapter(),
  new Gemma32bAdapter(),
  new Phi4Adapter()
];

/**
 * Tier-0a chain, built once at module load. SambaNova (3rd FAST free Llama
 * family) slots in right after cerebras so a burst that 429s groq+cerebras has
 * another FREE fallback before the paid tail. OpenRouter (aggregator) is the LAST
 * tier-0 fallback — after the paid tail, before we escalate to tier-1
 * (anthropic/openai).
 *
 * That last sentence used to read "after the free + cheap providers", which was
 * misleading in two ways worth not repeating: the three providers ahead of
 * OpenRouter are all PAID, and one of them (cohere, 0.50/1.50) is the most
 * expensive thing in tier-0 — the opposite of cheap. The tail is now explicitly
 * cost-ordered rather than described as if it were; see orderPaidTailByCost.
 *
 * Both are wired 2026-07-07 to activate idle-but-LIVE keys and are each gated by
 * an env flag (default ON) AND require their API key to be present — so a
 * missing key or a `false` flag silently drops the provider from the chain.
 * Reversible: ROUTER_ENABLE_SAMBANOVA=false / ROUTER_ENABLE_OPENROUTER=false.
 */
function buildTier0aAdapters(): ProviderAdapter[] {
  const chain: ProviderAdapter[] = [
    new GroqAdapter(),
    new CerebrasAdapter(),
  ];
  // Z.AI (Zhipu) direct — GLM on the vendor's free tier. Same gating convention as
  // sambanova/openrouter below: joins the chain when the key is present, one env var
  // to remove it.
  //
  // NOT a cost play. The $1.44 that motivated this was a pricing-table artifact
  // (see billing/pricing.ts) and cerebras GLM was always free. The real reasons:
  //   1. GLM is SINGLE-SOURCED today. Our cerebras key 404s on llama, so GLM is the
  //      only model that key can reach — and HAL's cerebras voice depends on it. If
  //      that one key or account lapses, a whole HAL quorum voice disappears.
  //   2. Second independent route to the same family, from the vendor rather than a
  //      reseller.
  // Placed AFTER groq/cerebras deliberately: a brand-new free tier that rate-limits
  // would otherwise put a 429 + retry in front of every request.
  if (process.env.ROUTER_ENABLE_ZAI !== 'false' && process.env.ZAI_API_KEY?.trim()) {
    chain.push(new ZaiAdapter());
  }
  if (process.env.ROUTER_ENABLE_SAMBANOVA !== 'false' && process.env.SAMBANOVA_API_KEY?.trim()) {
    chain.push(new SambaNovaAdapter());
  }
  chain.push(...orderPaidTailByCost([
    new GeminiAdapter(),
    new CohereAdapter(),
    new DeepSeekAdapter(),
  ]));
  // OpenRouter — LAST tier-0 fallback (after free + cheap, before tier-1 escalation).
  if (process.env.ROUTER_ENABLE_OPENROUTER !== 'false' && process.env.OPENROUTER_API_KEY?.trim()) {
    chain.push(new OpenRouterAdapter());
  }
  return applyFreeFirstOrder(chain);
}

/**
 * Cost-order the PAID tier-0 tail, cheapest first. Default ON; set
 * ROUTER_PAID_TAIL_COST_ORDER=false to restore the historical gemini > cohere >
 * deepseek order.
 *
 * WHY: the tail was ordered by the sequence adapters happened to be added, which put
 * cohere (0.50/1.50 — the most expensive provider in tier-0) ahead of deepseek
 * (0.27/1.10). Every request that exhausted the free head and failed gemini therefore
 * reached the dearest option before the cheaper one, for no stated reason.
 *
 * WHY IT IS SAFE TO DEFAULT ON, where free-first is not: this only reorders providers
 * that are already PAID and already in the chain, using prices this repo has explicit
 * entries for. It promotes nothing unpriced, changes no provider's presence, and the
 * ordering is invariant to prompt shape (see defaultBlendedPrice). Availability is
 * unchanged — the same set is tried, in a cheaper sequence.
 *
 * Unpriced providers sort LAST. 'unpriced' is not 'cheap' and must never win a
 * cost-ordering by default — the same doctrine that gives cost-class.ts three states.
 */
export function orderPaidTailByCost(tail: ProviderAdapter[]): ProviderAdapter[] {
  if (process.env.ROUTER_PAID_TAIL_COST_ORDER === 'false') return tail;
  return [...tail].sort((a, b) => {
    const pa = defaultBlendedPrice(a.name);
    const pb = defaultBlendedPrice(b.name);
    if (pa === null && pb === null) return 0; // both unknown — preserve declared order
    if (pa === null) return 1; // unknown sorts last
    if (pb === null) return -1;
    return pa - pb;
  });
}

/**
 * OPT-IN free-first reordering. DEFAULT OFF — the chain returned is byte-identical to
 * the one above unless ROUTER_FREE_FIRST_ORDER=true.
 *
 * WHAT IT ACTUALLY DOES, MEASURED 2026-08-20 — this is narrower than the name suggests
 * and the reason it stays off. Every genuinely free provider (groq, cerebras, zai,
 * sambanova) is ALREADY at the head of the chain. The partition is on FREE_PROVIDERS
 * membership, and the only member sitting behind a non-member is `openrouter`. So the
 * flag's entire effect is to move openrouter from last to position 5, ahead of gemini,
 * cohere and deepseek. Nothing else moves.
 *
 * WHY THAT IS NOT THE WIN IT SOUNDS LIKE: openrouter's default model is
 * `qwen/qwen-2.5-72b-instruct`, a cheap PAID variant drawn against a prepaid balance
 * (openrouter.ts:16-20), and it has NO entry in PRICING_PER_1M_TOKENS — so it classes
 * as `unpriced`, not `free`. Promoting it above gemini (0.075/0.30, priced) trades a
 * measurable cost for an unmeasurable one. `costClassDisagreements()` reports exactly
 * this: "FREE_PROVIDERS says free but no pricing entry exists — that is UNPRICED, not
 * free."
 *
 * So the free-tokens-first intent is served by orderPaidTailByCost above, not by this.
 * This flag remains available and correct for what it does; it should not be flipped
 * until openrouter and sambanova have real pricing entries, at which point the
 * partition would be on evidence rather than on an entitlement claim.
 *
 * The ordering is a STABLE partition on free-tier entitlement (FREE_PROVIDERS), not on
 * list price — see cost-class.ts:operationalCostClass for why those differ. Relative
 * order within each group is preserved, so the deliberate placements above (zai after
 * groq/cerebras because a brand-new free tier would put a 429+retry in front of every
 * request) survive intact.
 */
export function applyFreeFirstOrder(chain: ProviderAdapter[]): ProviderAdapter[] {
  if (process.env.ROUTER_FREE_FIRST_ORDER !== 'true') return chain;
  const free = chain.filter((a) => declaredFree(a.name));
  const rest = chain.filter((a) => !declaredFree(a.name));
  const reordered = [...free, ...rest];
  console.log(
    '[router] ROUTER_FREE_FIRST_ORDER=true — tier-0a chain reordered free-tier-first: ' +
      `${chain.map((a) => a.name).join(' > ')}  =>  ${reordered.map((a) => a.name).join(' > ')}`,
  );
  return reordered;
}

const tier0aAdapters: ProviderAdapter[] = buildTier0aAdapters();

const tier1Adapters: ProviderAdapter[] = [
  new AnthropicAdapter(),
  new OpenAIAdapter()
];

/**
 * The routing order, as data.
 *
 * The chains above are module-private consts built once at import, so until now the
 * only way to learn what order production actually walks was to read the source and
 * mentally evaluate four env-gated `if` blocks. That is not something a test, a health
 * endpoint, or an operator preparing a flip can do. These accessors expose the chain
 * AS BUILT in this process — including which optional providers actually joined.
 *
 * INERT: read-only views over the existing arrays. They copy, so a caller cannot mutate
 * the live chain through them.
 */
export function tier0aChainNames(): string[] {
  return tier0aAdapters.map((a) => a.name);
}
export function tier1ChainNames(): string[] {
  return tier1Adapters.map((a) => a.name);
}
export function slmChainNames(): string[] {
  return slmAdapters.map((a) => a.name);
}

/**
 * `ProviderAdapter.free` as each adapter declares it — surfaced ONLY so
 * cost-class.ts:costClassDisagreements can audit it against the other two
 * classifications. Nothing reads this field for routing; see cost-class.ts for why it
 * is dead metadata rather than a cost fact.
 */
export function adapterFreeFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of [...tier0aAdapters, ...tier1Adapters, ...slmAdapters]) out[a.name] = a.free;
  return out;
}

/**
 * The full ordered candidate list a request would walk, with tiers — the input the
 * routing record needs. Mirrors the walk order in routeRequest: SLM (low-complexity
 * only) → tier-0a → tier-1.
 */
export function routingChain(includeSlm: boolean): { provider: string; tier: '0a' | '1' | 'slm' }[] {
  const chain: { provider: string; tier: '0a' | '1' | 'slm' }[] = [];
  if (includeSlm) for (const a of slmAdapters) chain.push({ provider: a.name, tier: 'slm' });
  for (const a of tier0aAdapters) chain.push({ provider: a.name, tier: '0a' });
  for (const a of tier1Adapters) chain.push({ provider: a.name, tier: '1' });
  return chain;
}

/**
 * Resolve the API key for an adapter — THE ONE PLACE that knows how.
 *
 * This logic used to live only inside the routing loop in routes/route.ts, so
 * nothing could ask "is this provider even usable?" before selecting it. The
 * result: a keyless provider was chosen, consumed one of three routing
 * attempts, was excluded, and the request 503'd having never tried a provider
 * that actually works. A live smoke call did exactly that (2026-08-01).
 *
 * Exported so the pre-filter and the loop share one definition. Two copies of
 * key-resolution logic would drift the same way the two handler registries did.
 */
export function resolveAdapterKey(
  adapterName: string,
  adapterTier: number,
  userPaidKeys?: Record<string, string> | undefined
): string {
  if (adapterName === 'llama-3-2-1b' || adapterName === 'gemma-3-2b') {
    return process.env['HUGGINGFACE_API_TOKEN'] || process.env['HF_API_KEY'] || process.env['HF_TOKEN'] || '';
  }
  if (adapterName === 'phi-4') return process.env['CEREBRAS_API_KEY'] || '';
  if (adapterTier === 0) return process.env[`${adapterName.toUpperCase()}_API_KEY`] || '';
  return resolveTier1Key(adapterName, userPaidKeys) || '';
}

/**
 * Providers that CANNOT be used right now because no key resolves for them.
 *
 * Seeded into `excludeProviders` before the first selection, so `maxAttempts`
 * means that many REAL attempts instead of being spent on providers that were
 * never viable. Computed per-request because caller-supplied keys can make a
 * tier-1 adapter viable for one request and not the next.
 */
/**
 * Providers explicitly disabled by config, e.g.
 *   LLM_DISABLED_PROVIDERS=llama-3-2-1b,gemma-3-2b
 *
 * WHY THIS EXISTS AND NOT A HARDCODED LIST: a key can be PRESENT and DEAD. On
 * 2026-08-01 `HUGGINGFACE_API_TOKEN` was set both in the reference file and on
 * the deployed engine, so every presence-based check said "fine" — while
 * HuggingFace answered 400 "not supported by any provider you have enabled".
 * The cheapest tier routed there first, so real requests burned attempts on a
 * provider that could never succeed.
 *
 * Liveness is not knowable from config, so the operator states it. Config-driven
 * rather than hardcoded because which providers are entitled changes with the
 * account, not with the code, and this must be reversible in one env change.
 */
export function disabledProviders(): string[] {
  return (process.env['LLM_DISABLED_PROVIDERS'] ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function keylessProviders(userPaidKeys?: Record<string, string> | undefined): string[] {
  const out: string[] = [...disabledProviders()];
  for (const a of [...tier0aAdapters, ...tier1Adapters]) {
    if (!resolveAdapterKey(a.name, a.tier, userPaidKeys)) out.push(a.name);
  }
  return [...new Set(out)];
}

export function isLowComplexity(prompt: string, taskHint?: string): boolean {
  const p = prompt.toLowerCase();
  
  // 1. Task hint indicates low complexity
  const lowComplexityHints = ['classification', 'routing_decision', 'quick_check', 'factual', 'simple', 'short', 'hal_classify'];
  if (taskHint && lowComplexityHints.some(h => taskHint.toLowerCase().includes(h))) {
    return true;
  }
  
  // 2. Length check: very short prompts
  if (prompt.length < 200) {
    return true;
  }
  
  // 3. Keywords indicating simple tasks
  const keywords = [
    'classify', 'categorize', 'yes/no', 'yes or no', 'true/false', 'true or false', 
    'is this', 'simple factual', 'quick fact-check', 'one-word', 'short response'
  ];
  if (keywords.some(kw => p.includes(kw))) {
    return true;
  }

  return false;
}

/**
 * Resolve the credential for a Tier-1 provider (anthropic | openai).
 *
 * BUGFIX (2026-06-28, GA): Tier-1 candidates were ONLY ever eligible when the
 * caller supplied `user_paid_keys`. On the Fly deployment the provider keys are
 * present as ENV VARS (ANTHROPIC_API_KEY / OPENAI_API_KEY) but no caller passes
 * user_paid_keys, so a `tier_preference:"tier1_only"` request built ZERO Tier-1
 * candidates and returned `all_exhausted` with `tried:[]`. We now fall back to
 * the env key when a user-paid key is absent. Caller-supplied keys still win.
 */
export function resolveTier1Key(
  providerName: string,
  userPaidKeys?: { openai?: string; anthropic?: string }
): string | undefined {
  const userKey = userPaidKeys ? (userPaidKeys as any)[providerName] : undefined;
  if (userKey) return userKey;
  const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
  return envKey || undefined;
}

/**
 * Map a caller task hint to a task_domain the performance-lookup RPC actually has rows for.
 * The RPC keys on `repid_score_events.task_domain`; the live populated domains (30d) are
 * EVERGREEN, peer_verify, cait, system, review, heal. A hint that already names one of those is
 * used verbatim; anything unknown/absent (including the legacy 'general') maps to a configurable
 * populated default so ANFIS gets a real reliability signal instead of an empty set.
 * Pure + deterministic for the same env. Reversible via ROUTER_ANFIS_DEFAULT_DOMAIN.
 */
export const ANFIS_POPULATED_DOMAINS = ['EVERGREEN', 'peer_verify', 'cait', 'system', 'review', 'heal'] as const;

export function resolveAnfisDomain(taskHint?: string): string {
  const fallback = process.env.ROUTER_ANFIS_DEFAULT_DOMAIN || 'peer_verify';
  if (!taskHint) return fallback;
  const hint = taskHint.trim();
  // Exact (case-insensitive) match against a domain that has data.
  const exact = ANFIS_POPULATED_DOMAINS.find(d => d.toLowerCase() === hint.toLowerCase());
  if (exact) return exact;
  // An explicit 'general' (the old empty default) is treated as "no useful hint".
  if (hint.toLowerCase() === 'general' || hint.length === 0) return fallback;
  // Otherwise honor the caller's hint verbatim (it may be a real, less-common domain like
  // 'research'/'finance'); the RPC returns empty for it and ANFIS falls back gracefully.
  return hint;
}

async function getAnfisRecommendation(domain: string): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('anfis_provider_performance_lookup', {
      p_domain: domain,
      p_window_days: 30
    });
    if (error || !data || data.length === 0) return null;
    
    // Scored using fitness function: hit_rate * latencyFit * costFit
    // latency_budget = 5000ms, cost_budget = 100000 micro-USDC ($0.10)
    const scored = data.map((p: any) => {
      const avgLatency = Number(p.avg_latency_ms) || 1000;
      const avgCost = Number(p.avg_cost_usdc) || 1000;
      const hitRate = p.hit_rate !== null ? Number(p.hit_rate) : 0.8;
      
      const latencyFit = 5000 >= avgLatency ? 1.0 : 5000 / avgLatency;
      const costFit = 100000 >= avgCost ? 1.0 : 100000 / avgCost;
      
      return {
        provider: p.provider,
        score: hitRate * latencyFit * costFit
      };
    });
    
    scored.sort((a: any, b: any) => b.score - a.score);
    return scored[0]?.provider || null;
  } catch (e) {
    console.error('[anfis-routing] lookup failed, falling back:', e);
    return null;
  }
}

export interface RouteResult {
  adapter: ProviderAdapter | null;
  decision: RouteDecision;
  staticProvider: string;
  staticTier: string;
  anfisProvider: string;
  anfisTier: string;
  anfisConfidence: number;
  /**
   * Observability record for this decision — the candidate chain, each candidate's cost
   * class, and why each one lost. Always computed (it is a pure map over ~10 names);
   * only LOGGED when ROUTER_DECISION_RECORD=true, so log volume is unchanged by default.
   *
   * Additive optional field: existing callers destructure `{ adapter, decision }` and are
   * unaffected.
   */
  routingRecord?: RoutingRecord;
}

/**
 * Public entry point. Delegates to the unchanged selection logic, then attaches the
 * observability record.
 *
 * INERT: the record is DESCRIPTIVE. It is built after selection is complete and cannot
 * influence which adapter was chosen — `selectRoute` neither receives it nor knows it
 * exists.
 */
export async function routeRequest(
  req: RouteRequest,
  excludeProviders: string[] = [],
): Promise<RouteResult> {
  const result = await selectRoute(req, excludeProviders);

  let record: RoutingRecord;
  try {
    // `excludeProviders` is mutated by selectRoute (cap-hit / unhealthy providers are
    // pushed onto it), so by now it holds the accumulated exclusion set.
    const includeSlm = req.tier_preference === 'auto' && isLowComplexity(req.prompt, req.task_hint);
    const chain = routingChain(includeSlm);
    const keyless = keylessProviders(req.user_paid_keys);
    const disabled = disabledProviders();
    // isHealthy() is a synchronous in-memory map read (providers/health.ts) — safe to
    // consult here without I/O. A provider the walk never reached still reports its true
    // health, which is exactly what distinguishes "skipped, unusable" from "never tried".
    const unhealthy = chain.map((c) => c.provider).filter((p) => !isHealthy(p));

    // Fresh probe verdicts, if any have been recorded. This is a synchronous
    // in-memory ledger read — the refresh that fills it never runs on this path.
    //
    // Purely observational here: `assessLiveness` is not consulted for exclusion
    // (that is `livenessExcludedProviders`, which the selection path does not call
    // yet). What this buys today is the comparison that answers whether the
    // hand-maintained LLM_DISABLED_PROVIDERS list still matches reality — a
    // provider appearing in deadByProbe but not disabledByConfig is a live key
    // rotting in the chain, which is how the HuggingFace outage happened.
    const deadByProbe = livenessMode() === 'off' ? [] : deadProviders();

    record = buildRoutingRecord({
      chosen: result.decision.chosen_provider,
      chosenTier: result.decision.chosen_tier,
      reason: result.decision.reason,
      chain,
      excluded: result.decision.tried,
      disabledByConfig: disabled,
      keyless,
      deadByProbe,
      unhealthy,
      classify: operationalCostClass,
    });

    if (process.env.ROUTER_DECISION_RECORD === 'true') {
      console.log('[router-record]', summarizeRoutingRecord(record));
    }
  } catch (e: any) {
    // Observability must never break routing. A failed record is logged and dropped;
    // the selected adapter is returned regardless.
    console.warn('[router-record] failed to build routing record:', e?.message ?? e);
    return result;
  }

  return { ...result, routingRecord: record };
}

async function selectRoute(req: RouteRequest, excludeProviders: string[] = []): Promise<{
  adapter: ProviderAdapter | null;
  decision: RouteDecision;
  staticProvider: string;
  staticTier: string;
  anfisProvider: string;
  anfisTier: string;
  anfisConfidence: number;
}> {
  const tried: string[] = [...excludeProviders];

  // 1. Compute ANFIS choice
  const anfisRec = anfisRecommendProvider(req.prompt, req.task_hint);
  const anfisProvider = anfisRec.recommendedProvider;
  const anfisTier = anfisRec.recommendedTier;
  const anfisConfidence = anfisRec.confidence;

  // 2. Compute Static choice
  let staticProvider = 'none';
  let staticTier = 'none';
  let foundStatic = false;

  // Check SLM for low complexity in static mode
  if (req.tier_preference === 'auto' && isLowComplexity(req.prompt, req.task_hint)) {
    for (const adapter of slmAdapters) {
      if (!excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = 'slm';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // Check Tier 0a in static mode
  if (!foundStatic && req.tier_preference !== 'tier1_only') {
    for (const adapter of tier0aAdapters) {
      if (!excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = '0a';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // Check Tier 1 in static mode (env-key fallback so the static pick is non-'none'
  // on tier1_only requests where no user_paid_keys are supplied).
  if (!foundStatic && req.tier_preference !== 'tier0_only') {
    for (const adapter of tier1Adapters) {
      const key = resolveTier1Key(adapter.name, req.user_paid_keys);
      if (key && !excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = '1';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // TRACK A A2 SHADOW: always compute ANFIS rec alongside static (ANFIS does NOT decide yet).
  // Log both + outcome later (to anfis_routing_logs after schema apply).
  // Reversible: controlled by ROUTER_ANFIS_SHADOW (default on for sprint).
  let shadow: any = null;
  try {
    if (process.env.ROUTER_ANFIS_SHADOW !== 'false') {
      const staticStub = { chosen_provider: staticProvider, chosen_tier: staticTier as any, reason: 'static', tried: [] as string[] };
      shadow = computeShadowDecision(staticStub as any, req.prompt, req.task_hint);
      console.log('[ANFIS-SHADOW]', JSON.stringify(shadow));

      // PERSIST the shadow decision to anfis_routing_logs so ANFIS's would-be picks are queryable
      // (this is the measurement step — ANFIS still does NOT decide routing). Gated by
      // ANFIS_SHADOW_PERSIST (default ON). Fire-and-forget: tolerant insert, never blocks routing.
      void persistShadowDecision({
        prompt: req.prompt,
        taskHint: req.task_hint,
        staticProvider,
        staticTier,
        staticReason: foundStatic ? 'static_cost_order' : 'static_none',
        anfisProvider,
        anfisTier,
        anfisConfidence,
        selectedFeatures: anfisRec.lassoSelectedFeatures,
        nProviders: tier0aAdapters.length + tier1Adapters.length,
      });
    }
  } catch (e) {
    // tolerant for no key / no table yet
  }

  // 2026-07-30 — escalation-only ANFIS authority (PR #281 gate, wired here).
  // Inert unless ANFIS_ROUTING_MODE=escalate_only. The gate can only move
  // routing UP the capability ladder or laterally within a tier — never below
  // the static pick (the unfitted-policy silent-failure direction). If the
  // escalation target is unavailable (key/health/cap), we warn LOUDLY and fall
  // through to the normal static path — never a silent degradation.
  const escGate = applyEscalationOnly({ staticProvider, staticTier, anfisProvider, anfisTier });
  if (
    escGate.mode === 'escalate_only' &&
    !escGate.deescalation_blocked &&
    (escGate.escalated || escGate.provider !== staticProvider)
  ) {
    if (escGate.tier === '1' && req.tier_preference !== 'tier0_only') {
      for (const adapter of tier1Adapters) {
        if (adapter.name !== escGate.provider) continue;
        const key = resolveTier1Key(adapter.name, req.user_paid_keys);
        if (key && !excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
          const cap = await checkCap(adapter.name);
          if (cap.allowed) {
            return {
              adapter,
              decision: { chosen_provider: adapter.name, chosen_tier: '1', reason: 'anfis_escalation', tried },
              staticProvider, staticTier, anfisProvider, anfisTier, anfisConfidence,
            };
          }
        }
      }
      console.warn(`[router] ANFIS escalation to ${escGate.provider}/tier1 unavailable (key/health/cap) — using static path`);
    } else if (escGate.tier === '0a' && req.tier_preference !== 'tier1_only') {
      for (const adapter of tier0aAdapters) {
        if (adapter.name !== escGate.provider) continue;
        if (!excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
          const cap = await checkCap(adapter.name);
          if (cap.allowed) {
            return {
              adapter,
              decision: { chosen_provider: adapter.name, chosen_tier: '0a', reason: 'anfis_lateral', tried },
              staticProvider, staticTier, anfisProvider, anfisTier, anfisConfidence,
            };
          }
        }
      }
      console.warn(`[router] ANFIS lateral to ${escGate.provider}/tier0a unavailable (health/cap) — using static path`);
    }
  }

  // Intercept for low-complexity SLM routing
  if (req.tier_preference === 'auto' && isLowComplexity(req.prompt, req.task_hint)) {
    for (const adapter of slmAdapters) {
      if (excludeProviders.includes(adapter.name)) continue;

      if (await adapter.isHealthy()) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '0a',
            reason: 'slm_low_complexity',
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  // ANFIS recommendation lookup
  // R6 — STRICT cost-order: tier0a is already cost-sorted (free → cheap-paid; tier1 = escalation).
  // By default we enforce that order and do NOT let ANFIS reorder it (ANFIS optimizes latency/quality,
  // not cost, and currently drives 0 traffic — routing_decisions=0). Set ROUTER_STRICT_COST_ORDER=false
  // to restore ANFIS reordering. Reversible.
  const strictCostOrder = process.env.ROUTER_STRICT_COST_ORDER !== 'false';
  let anfisRecommended: string | null = null;
  if (!strictCostOrder && req.tier_preference === 'auto') {
    // ROOT-CAUSE #4 fix (GA 2026-06-26): the performance-lookup RPC filters
    // `repid_score_events.task_domain = p_domain`. The old default `'general'` matches almost
    // nothing (387 rows / 37 with a provider over 30d, verified live), so ANFIS always saw an
    // empty signal and fell back to static — i.e. ANFIS was structurally starved even when
    // ROUTER_STRICT_COST_ORDER=false. The real, populated domains are EVERGREEN / peer_verify /
    // cait / review / system / heal. Use the caller's hint when present; otherwise fall back to a
    // configurable POPULATED default (ROUTER_ANFIS_DEFAULT_DOMAIN, default 'peer_verify' — the
    // dominant real domain, 73k rows) instead of the empty 'general'.
    const domain = resolveAnfisDomain(req.task_hint);
    anfisRecommended = await getAnfisRecommendation(domain);
  }

  const tryTier0 = req.tier_preference !== 'tier1_only';
  const tryTier1 = req.tier_preference !== 'tier0_only';

  let capHit = false;

  if (tryTier0) {
    // Prioritize ANFIS recommendation in Tier 0a if applicable
    let prioritizedTier0 = [...tier0aAdapters];
    if (anfisRecommended) {
      const recIndex = prioritizedTier0.findIndex(a => a.name === anfisRecommended);
      if (recIndex > -1) {
        const [recAdapter] = prioritizedTier0.splice(recIndex, 1);
        prioritizedTier0.unshift(recAdapter!);
      }
    }

    for (const adapter of prioritizedTier0) {
      if (excludeProviders.includes(adapter.name)) continue;
      
      if (isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          markFailure(adapter.name, new Error('Cap hit'));
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          capHit = true;
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '0a',
            reason: tried.length === 0 ? 'priority_healthy' : (capHit ? 'cap_hit' : 'fallback_after_failure'),
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  // BUGFIX (2026-06-28): previously gated on `req.user_paid_keys`, which made
  // `tier1_only` requests build zero candidates on env-key deployments (Fly).
  // Now Tier-1 is eligible whenever a key resolves (user-paid OR env fallback).
  if (tryTier1) {
    // Prioritize ANFIS recommendation in Tier 1 if applicable
    let prioritizedTier1 = [...tier1Adapters];
    if (anfisRecommended) {
      const recIndex = prioritizedTier1.findIndex(a => a.name === anfisRecommended);
      if (recIndex > -1) {
        const [recAdapter] = prioritizedTier1.splice(recIndex, 1);
        prioritizedTier1.unshift(recAdapter!);
      }
    }

    for (const adapter of prioritizedTier1) {
      if (excludeProviders.includes(adapter.name)) continue;

      const key = resolveTier1Key(adapter.name, req.user_paid_keys);
      if (!key) continue;

      if (isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          markFailure(adapter.name, new Error('Cap hit'));
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          capHit = true;
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '1',
            reason: (req.tier_preference === 'tier1_only' || !tryTier0) ? 'tier1_required' : (capHit ? 'cap_hit' : 'fallback_after_failure'),
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  const finalDecision = {
    adapter: null,
    decision: {
      chosen_provider: 'none',
      chosen_tier: 'none' as const,
      reason: 'all_exhausted' as const,
      tried
    },
    staticProvider,
    staticTier,
    anfisProvider,
    anfisTier,
    anfisConfidence
  };
  if (shadow) {
    console.log('[ANFIS-SHADOW final]', JSON.stringify({ static: finalDecision.decision, anfis: shadow.anfis, delta: shadow.delta }));
  }
  return finalDecision;
}
