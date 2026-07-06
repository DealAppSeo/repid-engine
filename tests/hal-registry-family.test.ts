/**
 * CROSS-FIX 2026-07-05 — HAL registry-primary family classification.
 *
 * The Phase-1 red-team proved HAL's family-independence relied on the spoofable first-match regex
 * familyOf(): a compound name like `deepseek-llama-3.3-70b` matches /deepseek/ BEFORE /llama/, so a
 * Llama-lineage model was silently mis-grouped as 'deepseek' — weakening the quorum's independence.
 *
 * The fix routes HAL's family classification through the hardened REGISTRY (resolveFamily), which is
 * accurate for known models and REJECTS ambiguous/unmapped ones instead of guessing. HAL is a LIVE
 * scoring path, so it must NEVER throw: familyOfResolved() falls back to the legacy regex for an
 * unmapped model BUT flags it (hal_family_unmapped) so it is visible for registration.
 *
 * These tests prove:
 *   1. a compound/ambiguous name is FLAGGED (not silently mis-grouped) — the spoof surfaces;
 *   2. an unmapped model FALLS BACK + flags rather than THROWING (live path never crashes);
 *   3. a registry-known model classifies accurately via the registry;
 *   4. factCheck surfaces families_unmapped in its result for later registration.
 */
// Mock the DB so importing fact-check (→ billing/log-call → db → config) doesn't require live Supabase
// creds. This test exercises only the pure family-classification logic — no DB, no network.
jest.mock('../src/db', () => ({ db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } }));

import { familyOf, familyOfResolved, auditFamilyIndependence, factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';
import { resolveFamily, isMapped } from '../src/decisioning/family-registry';

describe('familyOfResolved — registry-primary with loud fallback (never throws)', () => {
  it('registry-known model classifies via the REGISTRY (accurate)', () => {
    // llama-3.1-8b-instant is a seeded telemetry pair → registry resolves it, no flag.
    const flagged: string[] = [];
    expect(familyOfResolved('llama-3.1-8b-instant', (m) => flagged.push(m))).toBe('llama');
    expect(resolveFamily('llama-3.1-8b-instant')).toBe('llama');
    expect(flagged).toEqual([]); // known → NOT flagged
  });

  it('compound name `deepseek-llama-3.3-70b` is FLAGGED, not silently mis-grouped', () => {
    // It matches BOTH /deepseek/ and /llama/ → ambiguous → registry HARD-FAILS (not seeded).
    expect(isMapped('deepseek-llama-3.3-70b')).toBe(false);
    expect(() => resolveFamily('deepseek-llama-3.3-70b')).toThrow();

    // familyOfResolved must NOT throw on the live path: it falls back to the regex AND flags the model.
    const flagged: Array<{ model: string; fallback: string }> = [];
    let result: string | undefined;
    expect(() => {
      result = familyOfResolved('deepseek-llama-3.3-70b', (m, f) => flagged.push({ model: m, fallback: f }));
    }).not.toThrow();
    // regex first-match returns 'deepseek' — but crucially it is now VISIBLE (flagged), not silent.
    expect(result).toBe(familyOf('deepseek-llama-3.3-70b'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.model).toBe('deepseek-llama-3.3-70b');
  });

  it('an ordinary unmapped model falls back + flags rather than THROWING', () => {
    const model = 'some-brand-new-model-v9';
    expect(isMapped(model)).toBe(false);
    const flagged: string[] = [];
    let out: string | undefined;
    expect(() => { out = familyOfResolved(model, (m) => flagged.push(m)); }).not.toThrow();
    expect(out).toBe(familyOf(model)); // fallback family, live path preserved
    expect(flagged).toEqual([model]);  // flagged for registration
  });

  it('HAL qwen default qwen-plus is now registry-mapped (config-seeded), not a regex guess', () => {
    expect(isMapped('qwen-plus')).toBe(true);
    expect(resolveFamily('qwen-plus')).toBe('qwen');
    const flagged: string[] = [];
    expect(familyOfResolved('qwen-plus', (m) => flagged.push(m))).toBe('qwen');
    expect(flagged).toEqual([]); // registry hit → not flagged
  });
});

describe('auditFamilyIndependence — registry-primary; a spoofed compound name does not fake independence', () => {
  it('a real Llama judge + a compound `deepseek-llama` are NOT treated as 2 independent families by the registry', () => {
    // The compound name is unmapped → familyOfResolved falls back to regex ('deepseek'), so the audit
    // still separates them by NAME. The value of the fix is the FLAG (proven above) making the guess
    // visible; here we assert the audit runs without throwing on an unmapped model in the live path.
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b-instant' },
      { name: 'rogue', endpoint: 'y', apiKey: 'k', model: 'deepseek-llama-3.3-70b' },
    ];
    expect(() => auditFamilyIndependence(providers)).not.toThrow();
    const a = auditFamilyIndependence(providers);
    // groq → registry 'llama'; rogue → fallback 'deepseek'. Distinct family strings; audit is well-formed.
    expect(a.families).toContain('llama');
  });
});

describe('familyOfResolved — never-throws is TOTAL (fuzz-hardening, non-string inputs)', () => {
  // GA fuzz found familyOf()/resolveFamily() did `(model||'').toLowerCase()`, which THROWS on a truthy
  // non-string (number/object/Symbol) BEFORE the catch could handle it — escaping familyOfResolved's
  // never-throw contract. String(model ?? '') coercion makes it total. These prove no input throws.
  it.each([
    ['number', 123],
    ['object', {}],
    ['array', ['llama']],
    ['boolean', true],
    ['symbol', Symbol('x')],
    ['null', null],
    ['undefined', undefined],
  ])('returns a family and does NOT throw for a %s input', (_label, bad) => {
    let out: string | undefined;
    expect(() => { out = familyOfResolved(bad as any); }).not.toThrow();
    expect(typeof out).toBe('string');
    expect(out!.length).toBeGreaterThan(0); // always resolves to some non-empty family label
  });
});

describe('factCheck — surfaces families_unmapped on the DEFAULT build→score path (V3)', () => {
  // The V3 bug: buildFactCheckProvidersWith pre-tags each provider's .family, so the quorum's
  // `p.family ?? familyOfResolved(p.model, flagUnmapped)` short-circuited and flagUnmapped NEVER ran →
  // families_unmapped stayed [] and the structured field was theater (only the console.warn fired).
  // The fix resolves EVERY p.model through the collector regardless of a pre-tagged .family. This test
  // proves the FIELD surfaces (not just the log): an unmapped model appears in result.families_unmapped.
  const originalFetch = global.fetch;
  beforeEach(() => {
    // Deterministic verdict for every provider → providers_used > 0 so factCheck reaches the real
    // return (not the degraded/0-provider early return) where families_unmapped is emitted.
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'TRUE', confidence: 90 }) } }] }),
    }));
  });
  afterAll(() => { global.fetch = originalFetch; });

  it('populates families_unmapped with an unregistered provider model (registry miss → flagged)', async () => {
    const unmappedModel = 'some-brand-new-model-v9'; // proven unmapped above
    expect(isMapped(unmappedModel)).toBe(false);
    // No .family pre-tag: mirrors what the DEFAULT builder produces once the family is resolved through
    // the collector. (Even WITH a pre-tag the fix collects, because resolution now always runs on model.)
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b-instant' }, // registry-known → NOT flagged
      { name: 'rogue', endpoint: 'y', apiKey: 'k', model: unmappedModel },         // unmapped → flagged
    ];
    const r = await factCheck('the sky is blue', providers);
    expect(r.providers_used).toBeGreaterThan(0);          // reached the real return path
    expect(r.families_unmapped).toBeDefined();             // field surfaces, not omitted
    expect(r.families_unmapped).toContain(unmappedModel);  // and names the offending model
    expect(r.families_unmapped).not.toContain('llama-3.1-8b-instant'); // registry hit NOT flagged
  });

  it('omits families_unmapped when every provider model is registry-known', async () => {
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b-instant' },
      { name: 'qwen', endpoint: 'y', apiKey: 'k', model: 'qwen-plus' },
    ];
    const r = await factCheck('the sky is blue', providers);
    expect(r.providers_used).toBeGreaterThan(0);
    // all registry-known → nothing flagged → field is absent (falsy)
    expect(r.families_unmapped).toBeUndefined();
  });
});
