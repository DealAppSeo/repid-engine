/**
 * routing-cost-class.test.ts — locks the three-state cost class and the ONE distinction
 * that has already cost this repo a fabricated number: unpriced is NOT free.
 *
 * Also pins the set of places where the repo's three free-vs-paid classifications
 * disagree, so the list is a queryable fact instead of tribal knowledge, and so adding a
 * fourth contradiction turns a test red.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import * as fs from 'fs';
import * as path from 'path';
import {
  costClass,
  defaultCostClass,
  operationalCostClass,
  declaredFree,
  isConfirmedFree,
  costClassDisagreements,
  ADAPTER_DEFAULT_MODELS,
} from '../src/providers/cost-class';
import { calculateCost } from '../src/billing/pricing';

describe('three-state cost class — unpriced is its own answer', () => {
  it('an explicit zero-rate entry is free', () => {
    expect(costClass('zai', 'glm-4.5-flash')).toBe('free');
    expect(costClass('cerebras', 'zai-glm-4.7')).toBe('free');
  });

  it('an explicit non-zero entry is paid', () => {
    expect(costClass('gemini', 'gemini-1.5-flash')).toBe('paid');
    expect(costClass('deepseek', 'deepseek-chat')).toBe('paid');
  });

  it('a MISSING model in a KNOWN provider is unpriced, never free', () => {
    expect(costClass('groq', 'some-model-nobody-priced')).toBe('unpriced');
  });

  it('a MISSING provider is unpriced, never free', () => {
    expect(costClass('sambanova', 'Meta-Llama-3.1-8B-Instruct')).toBe('unpriced');
    expect(costClass('openrouter', 'qwen/qwen-2.5-72b-instruct')).toBe('unpriced');
  });

  it('THE TRAP: calculateCost returns 0 for an unpriced model — and 0 must not be read as free', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A genuine free tier and an unpriced model both return 0 from the calculator...
      expect(calculateCost('zai', 'glm-4.5-flash', 1_000_000, 1_000_000)).toBe(0);
      expect(calculateCost('groq', 'a-model-nobody-priced', 1_000_000, 1_000_000)).toBe(0);
      // ...but they are NOT the same claim, and the class keeps them apart.
      expect(costClass('zai', 'glm-4.5-flash')).toBe('free');
      expect(costClass('groq', 'a-model-nobody-priced')).toBe('unpriced');
      // Only the unpriced one warns.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('UNPRICED MODEL');
    } finally {
      warn.mockRestore();
    }
  });

  it('GAP: an unknown PROVIDER returns 0 SILENTLY — only an unknown MODEL warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // pricing.ts:47 `if (!providerPricing) return 0;` returns before the warn at :68.
      // So the loudness of the "we did not price this" signal depends on WHICH half is
      // missing — and the silent half covers the providers with no table at all:
      // openrouter, sambanova, and all three SLMs (llama-3-2-1b / gemma-3-2b / phi-4).
      // Verified live 2026-08-03: 40 openrouter + 8 phi-4 + 2 llama-3-2-1b calls in the
      // last 7 days all recorded cost 0 with no warning emitted.
      expect(calculateCost('openrouter', 'qwen/qwen-2.5-72b-instruct', 1_000_000, 1_000_000)).toBe(0);
      expect(calculateCost('sambanova', 'Meta-Llama-3.1-8B-Instruct', 1_000_000, 1_000_000)).toBe(0);
      expect(warn).not.toHaveBeenCalled(); // <- the gap

      // costClass closes it at the classification layer regardless of which half is absent.
      expect(costClass('openrouter', 'qwen/qwen-2.5-72b-instruct')).toBe('unpriced');
      expect(costClass('sambanova', 'Meta-Llama-3.1-8B-Instruct')).toBe('unpriced');
    } finally {
      warn.mockRestore();
    }
    // NOT FIXED HERE: making the provider-missing branch warn is a change to
    // src/billing/pricing.ts, outside this lane's fence.
  });

  it('isConfirmedFree refuses to vouch for an unpriced provider', () => {
    expect(isConfirmedFree('zai')).toBe(true);
    expect(isConfirmedFree('sambanova')).toBe(false); // unpriced — we do not know
    expect(isConfirmedFree('openrouter')).toBe(false); // unpriced — we do not know
    expect(isConfirmedFree('gemini')).toBe(false); // priced non-zero
  });
});

describe('the two lenses answer different questions and both are needed', () => {
  it('pricing lens: only zai is confirmed free across the whole tier-0a chain', () => {
    const chain = ['groq', 'cerebras', 'zai', 'sambanova', 'gemini', 'cohere', 'deepseek', 'openrouter'];
    expect(chain.filter((p) => defaultCostClass(p) === 'free')).toEqual(['zai']);
    // groq JOINED the unpriced set on 2026-08-21. Groq shut down `llama-3.1-8b-instant`
    // on 2026-08-16, so the default moved to its documented replacement — for which we
    // hold no price. Deliberately NOT given an invented { in: 0, out: 0 } entry: this
    // module's whole doctrine is that `free` means someone ASSERTED a zero rate, and we
    // have not. The free-tier entitlement is carried by FREE_PROVIDERS instead, which is
    // the lens below and the one routing actually consumes.
    expect(chain.filter((p) => defaultCostClass(p) === 'unpriced')).toEqual([
      'groq',
      'sambanova',
      'openrouter',
    ]);
  });

  it('entitlement lens: five of the eight carry a free-tier entitlement', () => {
    const chain = ['groq', 'cerebras', 'zai', 'sambanova', 'gemini', 'cohere', 'deepseek', 'openrouter'];
    expect(chain.filter(declaredFree)).toEqual(['groq', 'cerebras', 'zai', 'sambanova', 'openrouter']);
  });

  it('operational lens prefers the entitlement, and still reports unpriced when neither knows', () => {
    // groq: we hold NO price for its default model, but we are on its free tier —
    // entitlement wins. This is the sharpest case for the operational lens: the pricing
    // lens genuinely does not know, and collapsing "we don't know" into "it's paid"
    // would push a provider we pay nothing for to the back of the chain.
    expect(defaultCostClass('groq')).toBe('unpriced');
    expect(operationalCostClass('groq')).toBe('free');
    // anthropic: no entitlement and no pricing row for its default model.
    expect(operationalCostClass('anthropic')).toBe('unpriced');
  });
});

describe('the three classifications disagree — pinned so a fourth contradiction is caught', () => {
  it('enumerates the known disagreements', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adapterFreeFlags } = require('../src/providers/router');
    const found = costClassDisagreements(adapterFreeFlags());
    const byProvider = Object.fromEntries(found.map((d) => [d.provider, d]));

    // FREE_PROVIDERS says free; the pricing table charges for the default model.
    expect(byProvider.cerebras?.pricingClass).toBe('paid');

    // FREE_PROVIDERS says free; there is no pricing row at all — that is UNPRICED.
    // groq moved from the block above to this one on 2026-08-21 when its default model
    // changed to one we hold no price for. Still a disagreement, still pinned — only the
    // SHAPE of the disagreement changed, from "priced non-zero" to "not priced at all".
    expect(byProvider.groq?.pricingClass).toBe('unpriced');
    expect(byProvider.groq?.inFreeProvidersSet).toBe(true);
    expect(byProvider.sambanova?.pricingClass).toBe('unpriced');
    expect(byProvider.openrouter?.pricingClass).toBe('unpriced');

    // ProviderAdapter.free = true on providers billed at real rates. This field is read
    // by NOTHING in the routing path; it means "tier 0", not "costs nothing".
    expect(byProvider.gemini?.adapterFree).toBe(true);
    expect(byProvider.gemini?.pricingClass).toBe('paid');
    expect(byProvider.cohere?.adapterFree).toBe(true);
    expect(byProvider.deepseek?.adapterFree).toBe(true);

    // Providers with no disagreement stay out of the list.
    expect(byProvider.zai).toBeUndefined();
    expect(byProvider.openai).toBeUndefined();
  });

  it('every disagreement carries a human-readable reason', () => {
    for (const d of costClassDisagreements()) {
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('ADAPTER_DEFAULT_MODELS drift guard', () => {
  const SRC = path.join(__dirname, '..', 'src', 'providers');

  // Each adapter's default model is a literal inside its complete() method. The table in
  // cost-class.ts mirrors those literals; this reads the real source so the mirror cannot
  // rot silently.
  const cases: [string, string][] = [
    ['groq', 'groq.ts'],
    ['cerebras', 'cerebras.ts'],
    ['gemini', 'gemini.ts'],
    ['cohere', 'cohere.ts'],
    ['deepseek', 'deepseek.ts'],
    ['anthropic', 'anthropic.ts'],
    ['openai', 'openai.ts'],
    ['openrouter', 'openrouter.ts'],
    ['sambanova', 'sambanova.ts'],
    ['zai', 'zai.ts'],
  ];

  it.each(cases)('%s default model matches the literal in %s', (provider, file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const expected = ADAPTER_DEFAULT_MODELS[provider]!;
    expect(src).toContain(`'${expected}'`);
  });

  it('covers every adapter that can be routed to', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/providers/router');
    for (const name of [...router.tier0aChainNames(), ...router.tier1ChainNames()]) {
      expect(ADAPTER_DEFAULT_MODELS[name]).toBeDefined();
    }
  });
});
