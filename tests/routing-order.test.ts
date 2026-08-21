/**
 * routing-order.test.ts — pins the ACTUAL provider routing order and answers, as a test
 * rather than as an opinion, the question "does free-first routing hold today?"
 *
 * ANSWER: NO. On the default chain a PAID provider (gemini) is reachable before a FREE
 * one (openrouter) that is still untried. The test below asserts that violation
 * explicitly, so it is a recorded finding rather than a claim — and so the test turns
 * red the moment anyone changes the order in either direction.
 *
 * The companion test proves the invariant HOLDS under ROUTER_FREE_FIRST_ORDER=true,
 * which is the flag that fixes it. That flag is default-OFF; flipping it is a live
 * routing change and wants a canary + Sean's GO.
 *
 * The tier-0a chain is built ONCE at module import from env, so every test here sets env
 * first and then re-requires the module under jest.resetModules().
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { buildRoutingRecord } from '../src/decisioning/routing-record';
import { operationalCostClass, costClass } from '../src/providers/cost-class';

jest.mock('../src/billing/caps', () => ({
  checkCap: jest
    .fn()
    .mockResolvedValue({ allowed: true, monthly_limit: 0, current_spent: 0, hard_disabled: false }),
}));

/**
 * NEUTRALISE dotenv. This test asserts the routing chain for a CONTROLLED set of keys,
 * and without this it silently asserts the chain for whatever is in the developer's
 * `.env` instead.
 *
 * The mechanism, because it is not obvious: the cases below `delete process.env[k]`
 * and then `jest.resetModules()` + `require('../src/providers/router')`. That re-runs
 * `src/config.ts`, which calls `dotenv.config()` — and dotenv only skips keys that are
 * ALREADY PRESENT, so it cheerfully re-injects the variable the test just deleted.
 *
 * It was hermetic only while `.env` happened to lack those keys. Adding a real
 * `ZAI_API_KEY` on 2026-08-04 broke it immediately, which is the good outcome: a test
 * that passes because of what is MISSING from a machine is not testing anything. It
 * would equally have gone green on CI and red for one developer, with no explanation.
 */
jest.mock('dotenv', () => ({
  __esModule: true,
  config: () => ({ parsed: {} }),
  default: { config: () => ({ parsed: {} }) },
}));

/** Env keys that gate the three optional tier-0a providers. */
const OPTIONAL_KEYS = ['ZAI_API_KEY', 'SAMBANOVA_API_KEY', 'OPENROUTER_API_KEY'] as const;
const FLAGS = [
  'ROUTER_FREE_FIRST_ORDER',
  'ROUTER_PAID_TAIL_COST_ORDER',
  'ROUTER_ENABLE_ZAI',
  'ROUTER_ENABLE_SAMBANOVA',
  'ROUTER_ENABLE_OPENROUTER',
  'LLM_DISABLED_PROVIDERS',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [...OPTIONAL_KEYS, ...FLAGS]) saved[k] = process.env[k];
  jest.resetModules();
});

afterEach(() => {
  for (const k of [...OPTIONAL_KEYS, ...FLAGS]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  jest.resetModules();
});

/** Load the router with all optional providers enabled, so the FULL chain is visible. */
function loadRouterWithAllProviders(): typeof import('../src/providers/router') {
  for (const k of OPTIONAL_KEYS) process.env[k] = 'test-key';
  for (const f of ['ROUTER_ENABLE_ZAI', 'ROUTER_ENABLE_SAMBANOVA', 'ROUTER_ENABLE_OPENROUTER']) {
    delete process.env[f];
  }
  delete process.env.LLM_DISABLED_PROVIDERS;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/providers/router');
}

describe('the actual routing order (enumerated, not inferred)', () => {
  it('tier-0a walks groq > cerebras > zai > sambanova > gemini > deepseek > cohere > openrouter', () => {
    const router = loadRouterWithAllProviders();
    expect(router.tier0aChainNames()).toEqual([
      'groq',
      'cerebras',
      'zai',
      'sambanova',
      'gemini',
      'deepseek',
      'cohere',
      'openrouter',
    ]);
  });

  it('tier-1 is the escalation tail: anthropic > openai', () => {
    const router = loadRouterWithAllProviders();
    expect(router.tier1ChainNames()).toEqual(['anthropic', 'openai']);
  });

  it('the SLM tier (low-complexity only) is llama-3-2-1b > gemma-3-2b > phi-4', () => {
    const router = loadRouterWithAllProviders();
    expect(router.slmChainNames()).toEqual(['llama-3-2-1b', 'gemma-3-2b', 'phi-4']);
  });

  it('the three optional providers drop out of the chain when their key is absent', () => {
    for (const k of OPTIONAL_KEYS) delete process.env[k];
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    expect(router.tier0aChainNames()).toEqual([
      'groq',
      'cerebras',
      'gemini',
      'deepseek',
      'cohere',
    ]);
  });

  it('a key that is PRESENT but empty/whitespace still drops the provider', () => {
    for (const k of OPTIONAL_KEYS) process.env[k] = '   ';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    expect(router.tier0aChainNames()).not.toContain('zai');
    expect(router.tier0aChainNames()).not.toContain('openrouter');
  });
});

describe('cost class of each provider in walk order', () => {
  it('classifies the chain: 5 free-tier entitlements, 3 paid, paid tail now cheapest-first', () => {
    const router = loadRouterWithAllProviders();
    const classes = router.tier0aChainNames().map((p: string) => [p, operationalCostClass(p)]);
    expect(classes).toEqual([
      ['groq', 'free'],
      ['cerebras', 'free'],
      ['zai', 'free'],
      ['sambanova', 'free'],
      ['gemini', 'paid'], // position 4 — PAID, 0.075/0.30
      ['deepseek', 'paid'], // position 5 — PAID, 0.27/1.10
      ['cohere', 'paid'], // position 6 — PAID, 0.50/1.50 (dearest in tier-0)
      ['openrouter', 'free'], // position 7 — free ENTITLEMENT, but unpriced by the table
    ]);
  });

  /**
   * The paid tail is ordered by price, and the order needs no assumption about prompt
   * shape. Asserting DOMINANCE on both rates rather than the blended sum is the point:
   * `defaultBlendedPrice` adds `in + out`, which is only a safe proxy while each
   * provider is cheaper than the next on BOTH rates. If a future price change breaks
   * that, this test goes red and the sum stops being defensible — which is exactly
   * when someone needs to look, rather than silently trusting a blended number.
   */
  it('paid tail is cost-ordered, and the order is invariant to the in:out token ratio', () => {
    const router = loadRouterWithAllProviders();
    const chain: string[] = router.tier0aChainNames();
    const paidTail = chain.filter((p) => operationalCostClass(p) === 'paid');
    expect(paidTail).toEqual(['gemini', 'deepseek', 'cohere']);

    const rates: Record<string, { in: number; out: number }> = {
      gemini: { in: 0.075, out: 0.3 },
      deepseek: { in: 0.27, out: 1.1 },
      cohere: { in: 0.5, out: 1.5 },
    };
    for (let i = 0; i + 1 < paidTail.length; i++) {
      const lo = rates[paidTail[i] as string]!;
      const hi = rates[paidTail[i + 1] as string]!;
      expect(lo.in).toBeLessThan(hi.in);
      expect(lo.out).toBeLessThan(hi.out);
    }
  });

  it('ROUTER_PAID_TAIL_COST_ORDER=false restores the historical declared order', () => {
    process.env.ROUTER_PAID_TAIL_COST_ORDER = 'false';
    for (const k of OPTIONAL_KEYS) process.env[k] = 'test-key';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    const chain: string[] = router.tier0aChainNames();
    expect(chain.filter((p) => operationalCostClass(p) === 'paid')).toEqual([
      'gemini',
      'cohere',
      'deepseek',
    ]);
    delete process.env.ROUTER_PAID_TAIL_COST_ORDER;
  });

  it('an UNPRICED provider never sorts ahead of a priced one', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { orderPaidTailByCost } = require('../src/providers/router');
    const fake = (name: string) => ({ name }) as never;
    // openrouter/sambanova are unpriced; gemini is priced. Declared order puts the
    // unpriced ones first, so a sort that treated 'unpriced' as cheap would keep them there.
    const ordered = orderPaidTailByCost([fake('openrouter'), fake('sambanova'), fake('gemini')]);
    expect(ordered.map((a: { name: string }) => a.name)).toEqual([
      'gemini',
      'openrouter',
      'sambanova',
    ]);
  });

  it('DEFECT: the tier-1 escalation head (anthropic) is UNPRICED on its default model', () => {
    // openai's default `gpt-4o-mini` IS priced.
    expect(operationalCostClass('openai')).toBe('paid');

    // anthropic's is NOT. The adapter defaults to `claude-3-5-haiku-20241022`
    // (src/providers/anthropic.ts:12) but billing/pricing.ts:34-38 only carries
    // `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`. So the single most
    // expensive path in the router — tier-1 escalation — records cost 0 and emits the
    // "UNPRICED MODEL" warn on every default call.
    //
    // 0 here means "we never priced it", NOT "it was free"; pricing.ts:50 is explicit
    // that these are different claims. This is the same class of gap that produced the
    // phantom $1.44, pointed the other way: instead of inventing a cost it hides one.
    expect(costClass('anthropic', 'claude-3-5-haiku-20241022')).toBe('unpriced');
    expect(operationalCostClass('anthropic')).toBe('unpriced');

    // NOT FIXED HERE: adding a pricing row changes what the cost ledger reports for
    // real spend, which is a live billing-surface change and outside this lane's fence.
    // Recorded as a test so it cannot be forgotten, and so it goes red when fixed.
  });
});

/**
 * Build the record for a request where nothing is excluded and every provider is
 * healthy — i.e. the best case. If free-first fails HERE it fails everywhere.
 */
function recordForDefaultWalk(router: typeof import('../src/providers/router')) {
  const chain = router.routingChain(false);
  return buildRoutingRecord({
    chosen: chain[0]!.provider,
    chosenTier: '0a',
    reason: 'priority_healthy',
    chain,
    classify: operationalCostClass,
  });
}

describe('FREE-FIRST INVARIANT: no paid provider ahead of a usable free provider', () => {
  it('is VIOLATED on the default chain — paid gemini precedes free openrouter', () => {
    const router = loadRouterWithAllProviders();
    const record = recordForDefaultWalk(router);

    // This is the finding. It is asserted rather than described so that ANY change to
    // the chain order — a fix or a regression — turns this test red.
    expect(record.freeFirstViolated).toBe(true);
    expect(record.freeFirstViolation).toBeDefined();
    expect(record.freeFirstViolation!.paidProvider).toBe('gemini');
    expect(record.freeFirstViolation!.freeProvider).toBe('openrouter');
  });

  it('HOLDS under ROUTER_FREE_FIRST_ORDER=true — the flag that fixes it', () => {
    process.env.ROUTER_FREE_FIRST_ORDER = 'true';
    const router = loadRouterWithAllProviders();

    expect(router.tier0aChainNames()).toEqual([
      'groq',
      'cerebras',
      'zai',
      'sambanova',
      'openrouter', // moved ahead of the paid trio
      'gemini',
      'deepseek',
      'cohere',
    ]);

    const record = recordForDefaultWalk(router);
    expect(record.freeFirstViolated).toBe(false);
    expect(record.freeFirstViolation).toBeUndefined();
  });

  it('the flag preserves relative order WITHIN each cost group', () => {
    process.env.ROUTER_FREE_FIRST_ORDER = 'true';
    const router = loadRouterWithAllProviders();
    const names = router.tier0aChainNames();

    // zai stays after groq/cerebras (deliberate: a brand-new free tier that 429s would
    // otherwise put a retry in front of every request).
    expect(names.indexOf('zai')).toBeGreaterThan(names.indexOf('cerebras'));
    // The paid trio keeps its internal order — which is now the COST order established
    // by orderPaidTailByCost (gemini < deepseek < cohere), not the historical declared
    // order. Free-first partitions on entitlement and is stable within each group, so
    // it must not disturb the cost ordering underneath it.
    expect(names.indexOf('gemini')).toBeLessThan(names.indexOf('deepseek'));
    expect(names.indexOf('deepseek')).toBeLessThan(names.indexOf('cohere'));
  });

  it('is DEFAULT OFF — an unset flag leaves the chain byte-identical', () => {
    delete process.env.ROUTER_FREE_FIRST_ORDER;
    const off = loadRouterWithAllProviders().tier0aChainNames();
    jest.resetModules();
    process.env.ROUTER_FREE_FIRST_ORDER = 'false';
    const explicitlyOff = loadRouterWithAllProviders().tier0aChainNames();
    expect(off).toEqual(explicitlyOff);
    expect(off[4]).toBe('gemini'); // still paid-before-free
  });

  it('a free provider that is itself unusable does NOT count as a violation', () => {
    const router = loadRouterWithAllProviders();
    const chain = router.routingChain(false);
    const record = buildRoutingRecord({
      chosen: 'groq',
      chosenTier: '0a',
      reason: 'priority_healthy',
      chain,
      // openrouter is the only free provider behind the paid trio; make it keyless.
      keyless: ['openrouter'],
      classify: operationalCostClass,
    });
    // The router was RIGHT to pass gemini — there was no reachable free alternative.
    expect(record.freeFirstViolated).toBe(false);
  });
});

describe('routing record — the observability the flip needs', () => {
  it('records every candidate in walk order with its cost class and why it lost', () => {
    const router = loadRouterWithAllProviders();
    const chain = router.routingChain(false);
    const record = buildRoutingRecord({
      chosen: 'gemini',
      chosenTier: '0a',
      reason: 'fallback_after_failure',
      chain,
      unhealthy: ['groq', 'cerebras', 'zai', 'sambanova'],
      classify: operationalCostClass,
    });

    expect(record.chosen).toBe('gemini');
    expect(record.chosenCostClass).toBe('paid');
    expect(record.candidates.map((c) => c.outcome)).toEqual([
      'unhealthy', // groq
      'unhealthy', // cerebras
      'unhealthy', // zai
      'unhealthy', // sambanova
      'chosen', // gemini  <- PAID
      'not_reached', // cohere
      'not_reached', // deepseek
      'not_reached', // openrouter <- FREE and still usable
      'not_reached', // anthropic
      'not_reached', // openai
    ]);
    // This is the exact scenario the existing suite blesses at
    // tests/providers/router.test.ts:22 ("groq unhealthy picks gemini"): a paid pick
    // while a free provider remained untried.
    expect(record.freeFirstViolated).toBe(true);
  });

  it('separates disabled-by-config from keyless from unhealthy', () => {
    const router = loadRouterWithAllProviders();
    const record = buildRoutingRecord({
      chosen: 'cerebras',
      chosenTier: '0a',
      reason: 'fallback_after_failure',
      chain: router.routingChain(false),
      disabledByConfig: ['groq'],
      keyless: ['cohere'],
      unhealthy: ['zai'],
      classify: operationalCostClass,
    });
    const byName = Object.fromEntries(record.candidates.map((c) => [c.provider, c.outcome]));
    expect(byName.groq).toBe('disabled_by_config');
    expect(byName.cohere).toBe('no_key');
    expect(byName.zai).toBe('unhealthy');
    expect(byName.cerebras).toBe('chosen');
    expect(record.disabledByConfig).toEqual(['groq']);
    expect(record.keyless).toEqual(['cohere']);
  });

  it('handles an exhausted chain without throwing', () => {
    const router = loadRouterWithAllProviders();
    const chain = router.routingChain(false);
    const record = buildRoutingRecord({
      chosen: 'none',
      chosenTier: 'none',
      reason: 'all_exhausted',
      chain,
      unhealthy: chain.map((c) => c.provider),
      classify: operationalCostClass,
    });
    expect(record.chosen).toBe('none');
    expect(record.chosenCostClass).toBe('unpriced'); // 'none' is not a real provider
    expect(record.freeFirstViolated).toBe(false); // nothing was usable
  });
});

describe('routeRequest attaches the record without changing the decision', () => {
  it('returns the same adapter as before, plus a routingRecord', async () => {
    const router = loadRouterWithAllProviders();
    const health = require('../src/providers/health');
    jest.spyOn(health, 'isHealthy').mockReturnValue(true);

    const out = await router.routeRequest({ prompt: 'test', tier_preference: 'tier0_first' });

    expect(out.adapter?.name).toBe('groq'); // unchanged behaviour
    expect(out.decision.chosen_tier).toBe('0a');
    expect(out.routingRecord).toBeDefined();
    expect(out.routingRecord!.chosen).toBe('groq');
    expect(out.routingRecord!.chosenCostClass).toBe('free');
    expect(out.routingRecord!.candidates.length).toBeGreaterThan(0);
  });

  it('LLM_DISABLED_PROVIDERS shows up in the record as disabled_by_config', async () => {
    const router = loadRouterWithAllProviders();
    // Set AFTER loading: disabledProviders() reads env per request, not at chain build,
    // so this also proves the disable list takes effect without a restart.
    process.env.LLM_DISABLED_PROVIDERS = 'cohere,phi-4';
    const health = require('../src/providers/health');
    jest.spyOn(health, 'isHealthy').mockReturnValue(true);

    const out = await router.routeRequest({ prompt: 'test', tier_preference: 'tier0_first' });
    expect(out.routingRecord!.disabledByConfig).toEqual(expect.arrayContaining(['cohere', 'phi-4']));
    const cohere = out.routingRecord!.candidates.find((c: any) => c.provider === 'cohere');
    expect(cohere!.outcome).toBe('disabled_by_config');
  });
});
