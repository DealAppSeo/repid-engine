/**
 * cold-start-premium.test.ts — task 22.
 *  (1) shouldColdStartPremium gate logic (pure): master-off, scope, window, ANFIS difficulty gate.
 *  (2) getColdStartConfig repid_config → env → default precedence + fail-safe.
 *
 * router.ts imports ../db (config.ts throws without SUPABASE_URL) and cold-start-config also reads
 * repid_config — so we mock ../db. `rc` lets each test drive the repid_config rows the resolver sees.
 */
let rc: Array<{ key: string; value: string }> = [];
let rcError: string | null = null;

jest.mock('../src/db', () => ({
  db: {
    from: (_t: string) => ({
      select: (_c: string) => ({
        in: (_col: string, _keys: string[]) =>
          Promise.resolve(rcError ? { data: null, error: { message: rcError } } : { data: rc, error: null }),
      }),
    }),
  },
}));

import { shouldColdStartPremium, type RouteRequest } from '../src/providers/router';
import { getColdStartConfig, invalidateColdStartConfigCache, type ColdStartConfig } from '../src/providers/cold-start-config';

const baseCfg = (over: Partial<ColdStartConfig> = {}): ColdStartConfig => ({
  enabled: true,
  maxQuestions: 3,
  scopes: new Set(['new_user', 'new_chat', 'testing']),
  anfisGate: true,
  source: {},
  ...over,
});

// A genuinely non-trivial prompt: > 200 chars and free of the low-complexity keyword triggers, so
// isLowComplexity() returns false and the ANFIS difficulty gate does NOT spare it.
const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  prompt:
    'Walk through the design tradeoffs between recursive STARK aggregation and Groth16 leaf proofs when ' +
    'building a reputation rollup that must anchor to an EAS attestation on Base, including the field ' +
    'choice, the Poseidon2 migration path, and how the prover pin governs both tiers over time.',
  tier_preference: 'auto',
  ...over,
});

describe('shouldColdStartPremium — gate logic', () => {
  test('master OFF → never active, even for a qualifying request', () => {
    const r = shouldColdStartPremium(req({ cold_start: { scope: 'new_user', question_index: 0 } }), baseCfg({ enabled: false }));
    expect(r).toEqual({ active: false, reason: 'disabled' });
  });

  test('no cold_start context → inactive', () => {
    expect(shouldColdStartPremium(req(), baseCfg()).active).toBe(false);
  });

  test('scope not covered → inactive', () => {
    const r = shouldColdStartPremium(req({ cold_start: { scope: 'testing', question_index: 0 } }), baseCfg({ scopes: new Set(['new_user']) }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain('scope_not_covered');
  });

  test('within the first N questions of a covered scope → ACTIVE (frontier-first)', () => {
    const r = shouldColdStartPremium(req({ cold_start: { scope: 'new_chat', question_index: 2 } }), baseCfg());
    expect(r).toEqual({ active: true, reason: 'cold_start_premium' });
  });

  test('question_index at/after maxQuestions → past the window, inactive', () => {
    const r = shouldColdStartPremium(req({ cold_start: { scope: 'new_chat', question_index: 3 } }), baseCfg({ maxQuestions: 3 }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain('past_window');
  });

  test('ANFIS gate ON spares a trivially-easy question (stays free tier)', () => {
    const easy = req({ prompt: 'Classify: yes or no?', cold_start: { scope: 'new_user', question_index: 0 } });
    expect(shouldColdStartPremium(easy, baseCfg({ anfisGate: true }))).toEqual({ active: false, reason: 'anfis_gate_trivial' });
    // with the gate OFF the same trivial question DOES get premium (best-foot-forward, no difficulty filter)
    expect(shouldColdStartPremium(easy, baseCfg({ anfisGate: false })).active).toBe(true);
  });
});

describe('getColdStartConfig — precedence + fail-safe', () => {
  const ENV_KEYS = ['COLD_START_PREMIUM_ENABLED', 'COLD_START_PREMIUM_MAX_QUESTIONS', 'COLD_START_PREMIUM_SCOPE', 'COLD_START_ANFIS_GATE', 'HAL_CONFIG_FROM_DB'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; rc = []; rcError = null; invalidateColdStartConfigCache(); });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } invalidateColdStartConfigCache(); });

  test('defaults when nothing is set (master OFF, N=3, all scopes, gate ON)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const c = await getColdStartConfig();
    expect(c.enabled).toBe(false);
    expect(c.maxQuestions).toBe(3);
    expect(c.anfisGate).toBe(true);
    expect([...c.scopes].sort()).toEqual(['new_chat', 'new_user', 'testing']);
  });

  test('repid_config row wins over env', async () => {
    process.env.COLD_START_PREMIUM_ENABLED = 'false';
    process.env.COLD_START_PREMIUM_MAX_QUESTIONS = '9';
    rc = [
      { key: 'cold_start_premium_enabled', value: 'true' },
      { key: 'cold_start_premium_max_questions', value: '2' },
      { key: 'cold_start_premium_scope', value: 'testing' },
    ];
    const c = await getColdStartConfig();
    expect(c.enabled).toBe(true);            // db 'true' beats env 'false'
    expect(c.maxQuestions).toBe(2);          // db 2 beats env 9
    expect(c.source.enabled).toBe('db');
    expect([...c.scopes]).toEqual(['testing']);
  });

  test('env used when no db row', async () => {
    process.env.COLD_START_ANFIS_GATE = 'false';
    const c = await getColdStartConfig();
    expect(c.anfisGate).toBe(false);
    expect(c.source.anfisGate).toBe('env');
  });

  test('DB read failure is fail-safe → falls back to env/default (master stays OFF)', async () => {
    rcError = 'connection refused';
    const c = await getColdStartConfig();
    expect(c.enabled).toBe(false);
    expect(c.maxQuestions).toBe(3);
  });
});
