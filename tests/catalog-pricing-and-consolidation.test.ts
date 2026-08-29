/**
 * Vendor-published pricing, and the honesty that has to travel with consolidation.
 *
 * TWO PROBLEMS, ONE CHANGE.
 *
 * 1. INVISIBLE SPEND. `PRICING_PER_1M_TOKENS` is hand-maintained, so any model nobody typed a row
 *    for ledgers at 0 — and 0 is indistinguishable from free once stored. MEASURED over 30 days:
 *    frontier models routed through a gateway logged ~100k real tokens against $0.00 because no
 *    row existed. The catalog refresh was already fetching the vendor's published rate every 30
 *    minutes and throwing it away.
 *
 * 2. CONSOLIDATION HIDES CORRELATED FAILURE. Extra gateway slots buy families cheaply, but N
 *    families behind ONE host is N opinions that disappear in a single outage. The family count
 *    cannot express that, so the host count now travels beside it.
 *
 * THE SCALING FACTOR IS THE DANGEROUS PART. Vendors quote USD per SINGLE token; this table is per
 * 1M. Getting that wrong by 10^6 produces a number that looks plausible in isolation and is off by
 * a factor of a million — so it is pinned against a known rate end to end, not asserted in prose.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import {
  parseModelPricing,
  parseModelIds,
  catalogPriceFor,
  setCachedCatalog,
  getCachedCatalog,
} from '../src/hal/model-catalog';
import { calculateCost } from '../src/billing/pricing';

/** An OpenRouter-shaped body. `prompt`/`completion` are USD per SINGLE token, as strings. */
const OR_BODY = {
  data: [
    { id: 'qwen/qwen-2.5-72b-instruct', pricing: { prompt: '0.0000004', completion: '0.0000004' } },
    { id: 'anthropic/claude-sonnet-4', pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'nvidia/nemotron:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'mystery/model-with-no-pricing' },
    { id: 'broken/model', pricing: { prompt: 'N/A', completion: '0.001' } },
    { id: 'negative/model', pricing: { prompt: '-1', completion: '0.001' } },
  ],
};

afterEach(() => setCachedCatalog({ entries: {}, refreshed_at: null }));

describe('parseModelPricing — scaling and refusals', () => {
  it('converts per-token to per-1M, the factor that would be catastrophic to get wrong', () => {
    const p = parseModelPricing(OR_BODY);
    // $0.0000004/token === $0.40 per 1M. Not 0.0000004, not 400000.
    expect(p['qwen/qwen-2.5-72b-instruct']).toEqual({ in: 0.4, out: 0.4 });
    expect(p['anthropic/claude-sonnet-4']).toEqual({ in: 3, out: 15 });
  });

  it("keeps a vendor's explicit zero — that is 'free', which is not 'unpriced'", () => {
    expect(parseModelPricing(OR_BODY)['nvidia/nemotron:free']).toEqual({ in: 0, out: 0 });
  });

  it('omits a model with no pricing key rather than inventing one', () => {
    expect(parseModelPricing(OR_BODY)['mystery/model-with-no-pricing']).toBeUndefined();
  });

  it('omits unparseable and negative rates instead of coercing them to 0', () => {
    const p = parseModelPricing(OR_BODY);
    expect(p['broken/model']).toBeUndefined();
    expect(p['negative/model']).toBeUndefined();
  });

  it('returns an empty map for a body it does not recognise, never a partial guess', () => {
    expect(parseModelPricing({ nonsense: true })).toEqual({});
    expect(parseModelPricing(null)).toEqual({});
  });

  it('does not disturb id parsing — the two parsers read the same body', () => {
    expect(parseModelIds(OR_BODY)).toContain('mystery/model-with-no-pricing');
    expect(parseModelIds(OR_BODY)).toHaveLength(6);
  });
});

describe('catalogPriceFor — null, never zero, for the unknown case', () => {
  beforeEach(() => {
    setCachedCatalog({
      entries: {
        openrouter: {
          provider: 'openrouter',
          status: 'MEASURED',
          models: Object.keys(parseModelPricing(OR_BODY)),
          pricing: parseModelPricing(OR_BODY),
          detail: 'test',
          fetched_at: new Date().toISOString(),
        },
      },
      refreshed_at: new Date().toISOString(),
    });
  });

  it('returns the vendor rate for a priced model', () => {
    expect(catalogPriceFor('openrouter', 'anthropic/claude-sonnet-4')).toEqual({ in: 3, out: 15 });
  });

  it('returns NULL — not {in:0,out:0} — when nobody published a rate', () => {
    expect(catalogPriceFor('openrouter', 'mystery/model-with-no-pricing')).toBeNull();
    expect(catalogPriceFor('openrouter', 'never-heard-of-it')).toBeNull();
  });

  it('returns null for a provider with no catalog entry at all', () => {
    expect(catalogPriceFor('groq', 'anything')).toBeNull();
  });
});

describe('calculateCost — the invisible spend is now visible', () => {
  const warm = () =>
    setCachedCatalog({
      entries: {
        openrouter: {
          provider: 'openrouter',
          status: 'MEASURED',
          models: [],
          pricing: parseModelPricing(OR_BODY),
          detail: 'test',
          fetched_at: new Date().toISOString(),
        },
      },
      refreshed_at: new Date().toISOString(),
    });

  it('THE BUG: a gateway-routed frontier model used to cost $0.00 with real tokens', () => {
    // Cold catalog === the behaviour before this change. 100k tokens of Sonnet, billed as nothing.
    expect(getCachedCatalog().entries.openrouter).toBeUndefined();
    expect(calculateCost('openrouter', 'anthropic/claude-sonnet-4', 50_000, 50_000)).toBe(0);
  });

  it('THE FIX: the same call prices from the vendor catalog once it is warm', () => {
    warm();
    // 50k in at $3/1M + 50k out at $15/1M = 0.15 + 0.75
    expect(calculateCost('openrouter', 'anthropic/claude-sonnet-4', 50_000, 50_000)).toBeCloseTo(0.9, 6);
  });

  it('the hand-maintained table still WINS over the catalog — it is the human override', () => {
    // THIS TEST WAS VACUOUS AT FIRST WRITING and the failability pass is what exposed it: the
    // warm catalog held only an `openrouter` entry, so `catalogPriceFor('gemini', …)` returned
    // null whichever way precedence ran, and inverting the precedence in the source left all
    // assertions green. A conflicting entry is required or this proves nothing.
    setCachedCatalog({
      entries: {
        gemini: {
          provider: 'gemini',
          status: 'MEASURED',
          models: ['gemini-2.5-flash'],
          // Deliberately DIFFERENT from the static row's $0.30 in, so precedence is observable.
          pricing: { 'gemini-2.5-flash': { in: 99, out: 99 } },
          detail: 'test',
          fetched_at: new Date().toISOString(),
        },
      },
      refreshed_at: new Date().toISOString(),
    });
    // The static row asserts $0.30/1M in. If the catalog won, this would be 99.
    expect(calculateCost('gemini', 'gemini-2.5-flash', 1_000_000, 0)).toBeCloseTo(0.3, 6);
  });

  it('still reports 0 for a model neither source prices — unknown stays unknown', () => {
    warm();
    expect(calculateCost('openrouter', 'mystery/model-with-no-pricing', 10_000, 10_000)).toBe(0);
  });

  it("a vendor's explicit free tier costs 0 without the unpriced warning path", () => {
    warm();
    expect(calculateCost('openrouter', 'nvidia/nemotron:free', 1_000_000, 1_000_000)).toBe(0);
  });
});
