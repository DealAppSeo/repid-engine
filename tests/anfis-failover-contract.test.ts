/**
 * anfis-failover-contract.test.ts — locks the decision-contract guarantees (SPRINT §6).
 *
 * Mocks ../src/db so `decideFailover`'s shadow-log side effect runs without Supabase. Asserts the
 * five contract guarantees: well-formed output on all 8 surfaces, determinism, fail-safe on bad
 * input, stakes-conservatism, and shadow-by-default.
 */

// Capture every shadow-log insert so we can assert observability without a real DB.
(global as any).__resLogInserts = [];

jest.mock('../src/db', () => ({
  db: {
    from: (_table: string) => ({
      insert: (row: any) => {
        (global as any).__resLogInserts.push(row);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  },
}));

import {
  decideFailover,
  SURFACES,
  type FailoverDecision,
  type SurfaceSignal,
  type Surface,
  type TargetState,
} from '../src/resilience/decision-contract';

function mkTarget(name: string, over: Partial<TargetState> = {}): TargetState {
  return {
    target: name,
    healthy: true,
    consecutiveErrors: 0,
    latencyMsP50: 100,
    errorRate: 0.0,
    costPerUnit: 0.1,
    reliability: 0.9,
    lastSuccessAt: Date.now(),
    ...over,
  };
}

function mkSignal(surface: Surface, over: Partial<SurfaceSignal> = {}): SurfaceSignal {
  return {
    surface,
    primary: 'primary',
    candidates: [mkTarget('primary'), mkTarget('standby')],
    requestStakes: 0.1,
    requestHint: surface,
    ...over,
  };
}

function assertWellFormed(d: FailoverDecision, surface: Surface) {
  expect(d.surface).toBe(surface);
  expect(['use_primary', 'failover', 'rotate', 'trip_breaker', 'degrade']).toContain(d.action);
  expect(typeof d.chosenTarget).toBe('string');
  expect(d.chosenTarget.length).toBeGreaterThan(0);
  expect(d.confidence).toBeGreaterThanOrEqual(0);
  expect(d.confidence).toBeLessThanOrEqual(1);
  expect(Array.isArray(d.selectedFeatures)).toBe(true);
  expect(d.selectedFeatures.length).toBeGreaterThan(0);
  expect(typeof d.shadow).toBe('boolean');
}

describe('decision-contract guarantees', () => {
  const RESILIENCE_KEYS = Object.keys(process.env).filter(k => k.startsWith('RESILIENCE_'));
  beforeEach(() => {
    (global as any).__resLogInserts = [];
    for (const k of RESILIENCE_KEYS) delete process.env[k];
    delete process.env.RESILIENCE_MIN_CONFIDENCE;
  });

  // T1 — well-formed output on every surface
  test('T1 well-formed FailoverDecision on all 8 surfaces', () => {
    for (const surface of SURFACES) {
      // make the primary unhealthy so we exercise the failover ranking path too
      const sig = mkSignal(surface, {
        candidates: [
          mkTarget('primary', { healthy: false, errorRate: 0.9, consecutiveErrors: 5 }),
          mkTarget('standby', { healthy: true, errorRate: 0.0 }),
        ],
      });
      assertWellFormed(decideFailover(sig), surface);
    }
  });

  // T2 — deterministic
  test('T2 identical input → identical decision', () => {
    const sig = mkSignal('llm', {
      candidates: [
        mkTarget('primary', { healthy: false, errorRate: 0.8 }),
        mkTarget('standby', { healthy: true, errorRate: 0.05 }),
      ],
    });
    const a = decideFailover(sig);
    const b = decideFailover(sig);
    expect(a).toEqual(b);
  });

  // T3 — fail-safe on malformed input: never throws, holds primary, shadow
  test('T3 empty candidates → use_primary, shadow, no throw', () => {
    const sig = mkSignal('db_write', { candidates: [], primary: 'pool' });
    let d: FailoverDecision | undefined;
    expect(() => {
      d = decideFailover(sig);
    }).not.toThrow();
    expect(d!.action).toBe('use_primary');
    expect(d!.shadow).toBe(true);
  });

  // T4 — stakes conservatism: high stakes biases toward holding primary
  test('T4 high stakes is at least as conservative as low stakes', () => {
    const candidates = [
      mkTarget('primary', { healthy: true, errorRate: 0.35, latencyMsP50: 400 }),
      mkTarget('standby', { healthy: true, errorRate: 0.05, latencyMsP50: 120 }),
    ];
    const lowStakes = decideFailover(mkSignal('llm', { candidates, requestStakes: 0.05 }));
    const highStakes = decideFailover(mkSignal('llm', { candidates, requestStakes: 0.95 }));

    const moved = (d: FailoverDecision) => d.action === 'failover' || d.action === 'rotate';
    // high stakes must never be MORE eager to leave the primary than low stakes
    if (moved(highStakes)) {
      expect(moved(lowStakes)).toBe(true);
      // and when both move, high stakes is no more confident than low stakes
      expect(highStakes.confidence).toBeLessThanOrEqual(lowStakes.confidence + 1e-9);
    }
  });

  // T5 — shadow default: with a clean env, every surface is advisory-only
  test('T5 clean env → every surface decision.shadow===true', () => {
    for (const surface of SURFACES) {
      const sig = mkSignal(surface, {
        candidates: [
          mkTarget('primary', { healthy: false, errorRate: 0.9 }),
          mkTarget('standby', { healthy: true }),
        ],
      });
      expect(decideFailover(sig).shadow).toBe(true);
    }
  });

  // Observability — guarantee 5: each decision writes exactly one shadow row with notes.shadow
  test('shadow log: one row per decision with surface + shadow flag', async () => {
    (global as any).__resLogInserts = [];
    decideFailover(mkSignal('llm'));
    // allow the awaited-but-not-blocking insert microtask to flush
    await new Promise(r => setImmediate(r));
    const rows = (global as any).__resLogInserts;
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe('llm');
    expect(rows[0].notes.shadow).toBe(true);
    expect(rows[0].anfis_provider).toBeDefined();
  });

  // Enable flag flips shadow OFF for one surface (Phase 7 scaffolding), default stays OFF elsewhere
  test('per-surface enable flag controls shadow (default OFF)', () => {
    const sig = mkSignal('llm', {
      candidates: [mkTarget('primary', { healthy: false, errorRate: 0.9 }), mkTarget('standby')],
    });
    expect(decideFailover(sig).shadow).toBe(true); // default OFF → shadow
    process.env.RESILIENCE_ANFIS_ENABLE_LLM = 'true';
    process.env.RESILIENCE_ANFIS_SHADOW_LLM = 'false';
    expect(decideFailover(sig).shadow).toBe(false); // enabled + not forced-shadow → actuates
    // a DIFFERENT surface remains shadow with the same env
    expect(decideFailover(mkSignal('db_write', { candidates: sig.candidates })).shadow).toBe(true);
  });
});
