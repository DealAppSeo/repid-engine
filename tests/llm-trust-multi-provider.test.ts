/**
 * CC2 Round 13 (2026-05-27) — /api/v1/llm-trust window filter + envelope tests.
 *
 * Strategy: target the pure helpers in src/services/llm-trust.ts directly
 * (no supertest, no app import — fastest signal). Sean's Round 12 allow-list
 * + per-provider collapse + sort-DESC is upstream and already covered by
 * its own PR; this suite validates ONLY the CC2-added surface:
 *   * window parsing (24h default, allowlist, fallback on garbage input)
 *   * recency filter (in-window vs out-of-window, null last_decision dropped,
 *     window=all bypass)
 *   * envelope shape (additive fields, providers count matches array length)
 */

import {
  parseWindow,
  filterByWindow,
  buildEnvelope,
  ALLOWED_WINDOWS,
  DEFAULT_WINDOW,
} from '../src/services/llm-trust';

// ----- parseWindow ----------------------------------------------------------
describe('parseWindow', () => {
  test('default = 24h when query string missing', () => {
    const r = parseWindow(undefined);
    expect(r.window).toBe('24h');
    expect(r.cutoffIso).toBeTruthy();
    // cutoff is ~24h ago, within a 5-second jitter for test execution
    const ageMs = Date.now() - new Date(r.cutoffIso as string).getTime();
    expect(ageMs).toBeGreaterThan(24 * 3600 * 1000 - 5000);
    expect(ageMs).toBeLessThan(24 * 3600 * 1000 + 5000);
  });

  test('accepts all four allow-listed windows', () => {
    for (const w of ALLOWED_WINDOWS) {
      expect(parseWindow(w).window).toBe(w);
    }
  });

  test("window=all returns null cutoff (no filter)", () => {
    const r = parseWindow('all');
    expect(r.window).toBe('all');
    expect(r.cutoffIso).toBeNull();
  });

  test('garbage input falls back to default (24h)', () => {
    expect(parseWindow('forever').window).toBe(DEFAULT_WINDOW);
    expect(parseWindow('12h').window).toBe(DEFAULT_WINDOW); // 12h not allow-listed
    expect(parseWindow('  ').window).toBe(DEFAULT_WINDOW);
  });

  test('case-insensitive', () => {
    expect(parseWindow('24H').window).toBe('24h');
    expect(parseWindow('ALL').window).toBe('all');
  });

  test('array query strings (express dup-param) take first element', () => {
    expect(parseWindow(['7d', 'garbage']).window).toBe('7d');
  });

  test('cutoff differs across 24h vs 7d vs 30d', () => {
    const a = new Date(parseWindow('24h').cutoffIso!).getTime();
    const b = new Date(parseWindow('7d').cutoffIso!).getTime();
    const c = new Date(parseWindow('30d').cutoffIso!).getTime();
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
  });
});

// ----- filterByWindow -------------------------------------------------------
describe('filterByWindow', () => {
  const now = Date.now();
  const isoMinusHours = (h: number) => new Date(now - h * 3600 * 1000).toISOString();

  test('keeps rows inside window, drops older ones', () => {
    const rows = [
      { llm_provider: 'anthropic', last_decision: isoMinusHours(2) },   // 2h ago — in
      { llm_provider: 'groq', last_decision: isoMinusHours(72) },        // 3d ago — out (24h)
      { llm_provider: 'openai', last_decision: isoMinusHours(0.5) },     // 30min ago — in
    ];
    const cutoff = parseWindow('24h').cutoffIso;
    const out = filterByWindow(rows, cutoff);
    expect(out.map((r) => r.llm_provider).sort()).toEqual(['anthropic', 'openai']);
  });

  test('drops rows with null last_decision when a cutoff is set', () => {
    const rows = [
      { llm_provider: 'anthropic', last_decision: isoMinusHours(1) },
      { llm_provider: 'never-used', last_decision: null },
      { llm_provider: 'also-never', last_decision: undefined },
    ];
    const cutoff = parseWindow('24h').cutoffIso;
    const out = filterByWindow(rows, cutoff);
    expect(out.map((r) => r.llm_provider)).toEqual(['anthropic']);
  });

  test('window=all (null cutoff) returns all rows including null last_decision', () => {
    const rows = [
      { llm_provider: 'anthropic', last_decision: isoMinusHours(720) }, // 30d ago
      { llm_provider: 'never-used', last_decision: null },
    ];
    const out = filterByWindow(rows, null);
    expect(out).toHaveLength(2);
  });

  test('7d window includes things 24h excluded', () => {
    const rows = [
      { llm_provider: 'anthropic', last_decision: isoMinusHours(48) }, // 2d ago
    ];
    expect(filterByWindow(rows, parseWindow('24h').cutoffIso)).toHaveLength(0);
    expect(filterByWindow(rows, parseWindow('7d').cutoffIso)).toHaveLength(1);
  });

  test('empty input → empty output (no crash on edge case)', () => {
    expect(filterByWindow([], parseWindow('24h').cutoffIso)).toEqual([]);
  });

  test('malformed ISO falls outside the window (defensive)', () => {
    const rows = [
      { llm_provider: 'good', last_decision: isoMinusHours(1) },
      { llm_provider: 'malformed', last_decision: 'not-a-date' as any },
    ];
    const out = filterByWindow(rows, parseWindow('24h').cutoffIso);
    expect(out.map((r) => r.llm_provider)).toEqual(['good']);
  });
});

// ----- buildEnvelope --------------------------------------------------------
describe('buildEnvelope', () => {
  test('shape matches spec — additive fields all present', () => {
    const providers = [
      { llm_provider: 'anthropic', last_decision: '2026-05-27T18:00:00Z' },
      { llm_provider: 'openai', last_decision: '2026-05-27T17:30:00Z' },
    ];
    const env = buildEnvelope(providers, '24h', 3);
    expect(env.providers).toEqual(providers);
    expect(env.window).toBe('24h');
    expect(env.total_providers_tracked).toBe(3);
    expect(env.providers_active_in_window).toBe(2);
    expect(env.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('providers_active_in_window always matches providers.length', () => {
    expect(buildEnvelope([], '7d', 12).providers_active_in_window).toBe(0);
    expect(buildEnvelope([{ x: 1 }, { x: 2 }, { x: 3 }], 'all', 12).providers_active_in_window).toBe(3);
  });

  test('caller-supplied as_of (deterministic timestamps for tests)', () => {
    const fixed = new Date('2026-05-27T00:00:00Z');
    const env = buildEnvelope([], '24h', 3, fixed);
    expect(env.as_of).toBe('2026-05-27T00:00:00.000Z');
  });

  test('total_providers_tracked is independent of providers array length', () => {
    // Real-world expected scenario today: 3 providers tracked in ai_providers,
    // 0 active in last 24h. Envelope should reflect both numbers honestly.
    const env = buildEnvelope([], '24h', 3);
    expect(env.total_providers_tracked).toBe(3);
    expect(env.providers_active_in_window).toBe(0);
  });
});
