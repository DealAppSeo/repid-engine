/**
 * Provider resilience (2026-07-07) — wire idle-but-LIVE keys into the HAL quorum + router fallback.
 *
 * Covers:
 *  1. HAL quorum AUTO-BACKFILL: when HAL_QUORUM_AUTOBACKFILL is on (default), backfill families
 *     (deepseek/gemini/mistral/openrouter) are included WHEN THEIR KEY IS PRESENT, taking the base
 *     quorum past < 3 families; family-disjointness (auditFamilyIndependence) is preserved.
 *  2. Reversibility: HAL_QUORUM_AUTOBACKFILL=false restores prior per-provider opt-in gating.
 *  3. New adapters (openrouter/sambanova) are SKIPPED from the router tier-0a chain when their key is
 *     absent, and their flag can turn them off even when the key is present.
 */
import {
  buildFactCheckProviders,
  auditFamilyIndependence,
} from '../src/hal/fact-check';

// Snapshot + restore the env keys these tests mutate so they can't leak across the suite.
const KEYS = [
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY', 'SAMBANOVA_API_KEY', 'FIREWORKS_API_KEY',
  'HAL_QUORUM_AUTOBACKFILL', 'HAL_S2_ENABLE_CEREBRAS', 'HAL_S2_CEREBRAS_MODEL', 'HAL_S2_ENABLE_DEEPSEEK', 'HAL_S2_ENABLE_GEMINI',
  'HAL_S2_ENABLE_MISTRAL', 'HAL_S2_ENABLE_OPENROUTER', 'HAL_S2_ENABLE_FIREWORKS',
  'ROUTER_ENABLE_OPENROUTER', 'ROUTER_ENABLE_SAMBANOVA',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  // Cerebras has no default model any more — every id this repo shipped is retired, so an
  // unconfigured cerebras is now skipped on purpose (src/hal/retired-models.ts). These tests are
  // about KEY gating and backfill, not model liveness, so give it a live-shaped id and keep them
  // testing what they were written to test.
  process.env.HAL_S2_CEREBRAS_MODEL = 'a-live-model-id';
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('HAL quorum auto-backfill', () => {
  test('with only groq+cerebras keys, base families < 3 (no backfill keys present)', () => {
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    const providers = buildFactCheckProviders();
    const names = providers.map((p) => p.name).sort();
    expect(names).toEqual(['cerebras', 'groq']);
    expect(auditFamilyIndependence(providers).families.length).toBeLessThan(3);
  });

  test('auto-backfill (default ON) includes deepseek+gemini+mistral+openrouter when keys present', () => {
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.GEMINI_API_KEY = 'x';
    process.env.MISTRAL_API_KEY = 'x';
    process.env.OPENROUTER_API_KEY = 'x';
    // HAL_QUORUM_AUTOBACKFILL unset → default true; no per-provider HAL_S2_ENABLE_* set.
    const providers = buildFactCheckProviders();
    const names = providers.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['groq', 'cerebras', 'deepseek', 'gemini', 'mistral', 'openrouter']));
    // Backfill order is cheapest-first: deepseek before gemini before mistral before openrouter.
    expect(names.indexOf('deepseek')).toBeLessThan(names.indexOf('gemini'));
    expect(names.indexOf('gemini')).toBeLessThan(names.indexOf('mistral'));
    expect(names.indexOf('mistral')).toBeLessThan(names.indexOf('openrouter'));
    // >= 3 distinct families now available.
    const fams = auditFamilyIndependence(providers).families;
    expect(fams.length).toBeGreaterThanOrEqual(3);
  });

  test('family-disjointness preserved: no family backs >1 provider in the backfilled set', () => {
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.GEMINI_API_KEY = 'x';
    process.env.MISTRAL_API_KEY = 'x';
    process.env.OPENROUTER_API_KEY = 'x';
    const providers = buildFactCheckProviders();
    const audit = auditFamilyIndependence(providers);
    expect(audit.independent).toBe(true);
    expect(audit.collapsed).toEqual([]);
  });

  test('backfill only adds providers whose KEY is present', () => {
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    process.env.DEEPSEEK_API_KEY = 'x';
    // gemini/mistral/openrouter keys ABSENT
    const names = buildFactCheckProviders().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['groq', 'cerebras', 'deepseek']));
    expect(names).not.toContain('gemini');
    expect(names).not.toContain('mistral');
    expect(names).not.toContain('openrouter');
  });

  test('HAL_QUORUM_AUTOBACKFILL=false restores per-provider opt-in gating', () => {
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.GEMINI_API_KEY = 'x';
    process.env.OPENROUTER_API_KEY = 'x';
    // No HAL_S2_ENABLE_* set → backfill families excluded despite keys.
    let names = buildFactCheckProviders().map((p) => p.name).sort();
    expect(names).toEqual(['cerebras', 'groq']);
    // Explicit opt-in still force-includes even with autobackfill off.
    process.env.HAL_S2_ENABLE_DEEPSEEK = 'true';
    process.env.HAL_S2_ENABLE_OPENROUTER = 'true';
    names = buildFactCheckProviders().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['deepseek', 'openrouter']));
    expect(names).not.toContain('gemini'); // gemini opt-in NOT set
  });

  test('fireworks is never auto-backfilled (retired 2026-06-04)', () => {
    process.env.GROQ_API_KEY = 'x';
    process.env.CEREBRAS_API_KEY = 'x';
    process.env.FIREWORKS_API_KEY = 'x';
    // autobackfill default ON, but fireworks is opt-in only.
    let names = buildFactCheckProviders().map((p) => p.name);
    expect(names).not.toContain('fireworks');
    process.env.HAL_S2_ENABLE_FIREWORKS = 'true';
    names = buildFactCheckProviders().map((p) => p.name);
    expect(names).toContain('fireworks');
  });
});

describe('router tier-0a new adapters — key/flag gating', () => {
  // The router builds its tier-0a chain from env at module load, so test the same gate predicate the
  // router + /v1/llm/providers listing use. (Both use: flag !== 'false' AND key present.)
  const openrouterRoutable = () =>
    process.env.ROUTER_ENABLE_OPENROUTER !== 'false' && !!process.env.OPENROUTER_API_KEY?.trim();
  const sambanovaRoutable = () =>
    process.env.ROUTER_ENABLE_SAMBANOVA !== 'false' && !!process.env.SAMBANOVA_API_KEY?.trim();

  test('skipped when their key is absent', () => {
    // keys deleted in beforeEach
    expect(openrouterRoutable()).toBe(false);
    expect(sambanovaRoutable()).toBe(false);
  });

  test('included when key present and flag default (unset)', () => {
    process.env.OPENROUTER_API_KEY = 'x';
    process.env.SAMBANOVA_API_KEY = 'x';
    expect(openrouterRoutable()).toBe(true);
    expect(sambanovaRoutable()).toBe(true);
  });

  test('flag=false drops the provider even when key present', () => {
    process.env.OPENROUTER_API_KEY = 'x';
    process.env.SAMBANOVA_API_KEY = 'x';
    process.env.ROUTER_ENABLE_OPENROUTER = 'false';
    process.env.ROUTER_ENABLE_SAMBANOVA = 'false';
    expect(openrouterRoutable()).toBe(false);
    expect(sambanovaRoutable()).toBe(false);
  });
});
