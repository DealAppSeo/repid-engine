/**
 * Consolidation slots: one gateway carrying several families, and the honesty that must
 * travel with that.
 *
 * WHY THIS EXISTS. MEASURED over 30 days: ~$0.21 of token spend across ~22k calls. The bill is
 * not inference, it is the number of vendor RELATIONSHIPS — eight accounts, each with its own
 * minimum top-up. Consolidating onto one gateway cuts accounts without cutting families.
 *
 * THE DANGER IT INTRODUCES, which is the real subject of this suite. Four families behind one
 * host is four opinions and ONE outage away from a silent quorum. `families_used` cannot express
 * that — it is the right metric for reasoning independence and says nothing about correlated
 * failure. So the host count is asserted here beside it. Gemini was deliberately moved OFF the
 * shared gateway earlier for exactly this reason; these slots push the other way on purpose, and
 * the reporting has to stay honest about the trade.
 *
 * NO SLUG IS HARDCODED IN THE SOURCE. The single existing default already went stale once (the
 * old `qwen…:free` slug retired, 404'd, and the gateway silently contributed zero votes for
 * weeks). Extra slots therefore pass no default and select from the live catalog.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { buildFactCheckProvidersWith } from '../src/hal/fact-check';
import { setCachedCatalog } from '../src/hal/model-catalog';

const ONLY_OPENROUTER = {
  groq: false, cerebras: false, fireworks: false, deepseek: false, gemini: false,
  mistral: false, zai: false, openrouter: true,
} as any;

const saved = { ...process.env };

function warmCatalog(models: string[]) {
  setCachedCatalog({
    entries: {
      openrouter: {
        provider: 'openrouter',
        status: 'MEASURED',
        models,
        detail: 'test',
        fetched_at: new Date().toISOString(),
      },
    },
    refreshed_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  process.env = { ...saved };
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.HAL_S2_OPENROUTER_SLOTS;
  setCachedCatalog({ entries: {}, refreshed_at: null });
});
afterEach(() => {
  process.env = { ...saved };
  setCachedCatalog({ entries: {}, refreshed_at: null });
});

describe('consolidation slots', () => {
  it('DEFAULT IS UNCHANGED — one member, exactly as before this change', () => {
    // THE CATALOG MUST BE WARM HERE OR THIS TEST PROVES NOTHING, and the failability pass is
    // what exposed that: with a cold catalog the extra slots have nothing to select from and
    // are skipped anyway, so changing the DEFAULT from 1 to 3 in the source left this green.
    // A silent widening of the live trust path is the single worst outcome of this change and
    // it has to be the thing this test can actually see.
    warmCatalog([
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-small',
    ]);
    // No HAL_S2_OPENROUTER_SLOTS set — widening must be an operator decision, never a deploy.
    const built = buildFactCheckProvidersWith(ONLY_OPENROUTER);
    const or = built.filter((p) => p.name.startsWith('openrouter'));
    expect(or).toHaveLength(1);
    expect(or[0]!.name).toBe('openrouter');
  });

  it('registers extra members when slots are raised, each a distinct quorum voice', () => {
    warmCatalog([
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-small',
    ]);
    process.env.HAL_S2_OPENROUTER_SLOTS = '3';
    const built = buildFactCheckProvidersWith(ONLY_OPENROUTER);
    const or = built.filter((p) => p.name.startsWith('openrouter'));
    expect(or.length).toBeGreaterThan(1);
    // Distinct names, or the ledger and provider_health cannot tell them apart.
    expect(new Set(or.map((p) => p.name)).size).toBe(or.length);
  });

  it('extra slots pick DISTINCT families — a duplicate family buys nothing', () => {
    warmCatalog([
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'mistralai/mistral-small',
    ]);
    process.env.HAL_S2_OPENROUTER_SLOTS = '3';
    const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
    const families = or.map((p) => p.family).filter(Boolean);
    expect(new Set(families).size).toBe(families.length);
  });

  it('EVERY member points at the same host — this is what the family count hides', () => {
    warmCatalog(['qwen/qwen-2.5-72b-instruct', 'meta-llama/llama-3.3-70b-instruct']);
    process.env.HAL_S2_OPENROUTER_SLOTS = '2';
    const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
    const hosts = new Set(or.map((p) => new URL(p.endpoint).host));
    expect(hosts.size).toBe(1);
    expect([...hosts][0]).toBe('openrouter.ai');
    // Stated as an assertion rather than a comment: N voices, 1 point of failure.
    expect(or.length).toBeGreaterThanOrEqual(hosts.size);
  });

  it('a cold catalog adds no extra slots rather than guessing a slug', () => {
    // No catalog entry at all — the state before the first refresh completes.
    process.env.HAL_S2_OPENROUTER_SLOTS = '4';
    const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
    // The base member keeps its static default; the extra slots have nothing to choose from
    // and are skipped, rather than inventing a model id that would 404.
    expect(or).toHaveLength(1);
  });

  it('the slot count is bounded — a fat-fingered value cannot fan out unboundedly', () => {
    warmCatalog(['a/one', 'b/two', 'c/three', 'd/four', 'e/five', 'f/six', 'g/seven', 'h/eight']);
    process.env.HAL_S2_OPENROUTER_SLOTS = '999';
    const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
    expect(or.length).toBeLessThanOrEqual(6);
  });

  it('a nonsense slot value falls back to one member, never to zero', () => {
    for (const bad of ['abc', '', '0', '-3']) {
      process.env.HAL_S2_OPENROUTER_SLOTS = bad;
      const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
      expect(or.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('no key means no members at all — removing the key is the off-switch', () => {
    // This is how the account actually gets closed: delete the variable, the provider stops
    // registering. No code change needed to drop a vendor.
    delete process.env.OPENROUTER_API_KEY;
    process.env.HAL_S2_OPENROUTER_SLOTS = '4';
    const or = buildFactCheckProvidersWith(ONLY_OPENROUTER).filter((p) => p.name.startsWith('openrouter'));
    expect(or).toHaveLength(0);
  });
});
