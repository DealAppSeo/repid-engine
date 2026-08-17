/**
 * A VETO REQUIRES A PROVIDER — HAL must not emit `vetoed` having consulted nothing.
 *
 * WHY THIS EXISTS (measured, not theorised)
 * -----------------------------------------
 * `hal_runner_results`, hal_mode='fact-check-s2', gen_failed=false, 395 rows, split on whether any
 * provider SUCCEEDED (measured 2026-08-17 against the live table):
 *
 *   provider succeeded : n=336, 166 vetoes, 159 right /   7 wrong  → veto precision 0.9578
 *   NO provider        : n= 59,  41 vetoes,  19 right /  22 wrong  → veto precision 0.4634
 *
 * The second row is worse than a coin flip, and every one of those 41 vetoes carried the same
 * -10 RepID as an earned one (`src/scoring/repid-delta.ts` computeDelta, 'vetoed' → -10).
 *
 * Two independent signals corroborate that no provider backed those 41, so the finding does not
 * rest on the `providers_attempted` column alone (which is NOT trustworthy — see the report):
 *   - LATENCY: 43 of the 59 completed in 84-292 ms, in the same process and commit where a real
 *     cross-LLM call took 2396-10827 ms. A ~90 ms evaluation cannot contain a network round trip.
 *   - SIGNAL SHAPE: all 59 carry the local extractor's signal keys (epistemic_uncertainty,
 *     harm_probability, scope_appropriateness, ...) and NONE of the fact-check keys
 *     (provider_health, quorum, verdicts) that all 336 provider rows carry.
 *   - All 41 unearned vetoes sit BELOW the 0.43 veto threshold; all 166 earned vetoes sit above it.
 *     The veto came from `deriveDecision`'s `vetoed || sev === 'critical'` branch, not the score.
 *
 * THE GUARD UNDER TEST: `HAL_VETO_REQUIRES_PROVIDER` (default ON) in `src/hal/service.ts`.
 * It fires wherever HAL can positively establish that ZERO providers succeeded, which is three
 * distinct paths — a mode check alone would miss the third:
 *   1. `extractor-fallback` — strictness 2 requested, no provider produced a verdict.
 *   2. `extractor`          — strictness 1, local by construction.
 *   3. `local_slm`          — HAL_LOCAL_FALLBACK_ENABLED. THIS ONE LIES: it reports
 *      `providers_used: 1` for a `deliverable.includes('false')` string match, while honestly
 *      recording `provider_health.succeeded: 0`. It is therefore mode 'fact-check' and would
 *      sail past any providers_used/mode test. `provider_health.succeeded` is the honest field.
 */
jest.mock('../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => (global as any).__fc),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
}));
jest.mock('../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => (global as any).__ex),
}));

import { HalService } from '../src/hal/service';
import type { FactCheckProviderCfg } from '../src/hal/fact-check';

const svc = (n = 1) =>
  new HalService(() =>
    Array.from({ length: n }, (_, i) => ({ name: 'p' + i, endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg)),
  );

/** The local extractor returning a veto with no provider behind it — the measured 41-row shape. */
const EXTRACTOR_VETO = { hal_score: 0.2513835296630859, vetoed: true, signals: { comma_severity: null } };
const EXTRACTOR_CLEAN = { hal_score: 0.19664679336547852, vetoed: false, signals: { comma_severity: null } };

/** A real cross-provider veto: two families answered FALSE. This one is EARNED and must survive. */
const EARNED_VETO = {
  hal_score: 0.75,
  decision: 'vetoed',
  verdicts: [
    { provider: 'groq', verdict: 'FALSE', confidence: 90 },
    { provider: 'cerebras', verdict: 'FALSE', confidence: 88 },
  ],
  providers_used: 2,
  families_used: 2,
  agreement: 1,
  degraded: false,
  latency_ms: 3158,
  provider_health: { attempted: 2, succeeded: 2, failed: [] },
};

/**
 * The HAL_LOCAL_FALLBACK_ENABLED shape, copied from `src/hal/fact-check.ts`: providers_used is
 * fabricated to 1 for a substring match, while provider_health.succeeded stays truthfully 0.
 */
const LOCAL_SLM_VETO = {
  hal_score: 0.8,
  decision: 'vetoed',
  verdicts: [{ provider: 'local_slm', verdict: 'FALSE', confidence: 70, note: 'local slm fallback heuristic' }],
  providers_used: 1,
  agreement: 1.0,
  degraded: true,
  latency_ms: 12,
  provider_health: { attempted: 3, succeeded: 0, failed: [{ name: 'groq', error: 'timeout' }] },
  fallback_used: 'local_slm',
  confidence: 'degraded',
};

beforeEach(() => {
  (global as any).__fc = null;
  (global as any).__ex = EXTRACTOR_CLEAN;
  delete process.env.HAL_VETO_REQUIRES_PROVIDER;
  delete process.env.HAL_VETO_THRESHOLD;
  delete process.env.HAL_FLAG_THRESHOLD;
  delete process.env.EXECUTION_FLOOR_ENABLED;
});

describe('a veto requires a provider (HAL_VETO_REQUIRES_PROVIDER, default ON)', () => {
  test('extractor-fallback: strictness 2 with no provider must NOT veto', async () => {
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(0).evaluate({ text: 'The Eiffel Tower is in Berlin.' });

    expect(r.mode).toBe('extractor-fallback');
    expect(r.decision).not.toBe('vetoed');
    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed).toBeDefined();
    expect(r.veto_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
    expect(r.veto_suppressed!.providers_succeeded).toBe(0);
  });

  test('providers configured but none responded: still must NOT veto', async () => {
    (global as any).__fc = {
      hal_score: 0.5, decision: 'flagged', verdicts: [], providers_used: 0, agreement: null,
      degraded: true, latency_ms: 3180, provider_health: { attempted: 3, succeeded: 0, failed: [] },
    };
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(3).evaluate({ text: 'x' });

    expect(r.mode).toBe('extractor-fallback');
    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
  });

  test('strictness 1 extractor: a local veto is not evidence either', async () => {
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(1).evaluate({ text: 'x', strictness: 1 });

    expect(r.mode).toBe('extractor');
    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
  });

  test('local_slm fallback: fabricated providers_used:1 must not buy a veto', async () => {
    // THE path a mode/providers_used check would miss: mode is 'fact-check' and providers_used is 1,
    // but provider_health.succeeded is 0 and the "verdict" is a substring match on the word "false".
    (global as any).__fc = LOCAL_SLM_VETO;
    const r = await svc(3).evaluate({ text: 'This statement contains false claims.' });

    expect(r.mode).toBe('fact-check');
    expect(r.decision).not.toBe('vetoed');
    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
    expect(r.veto_suppressed!.providers_succeeded).toBe(0);
  });

  test('EARNED veto survives untouched — the guard must not cost recall', async () => {
    (global as any).__fc = EARNED_VETO;
    const r = await svc(2).evaluate({ text: 'The Eiffel Tower is in Berlin.' });

    expect(r.mode).toBe('fact-check');
    expect(r.decision).toBe('vetoed');
    expect(r.veto_suppressed).toBeUndefined();
  });

  test('non-veto decisions are never rewritten (clean stays clean)', async () => {
    (global as any).__ex = EXTRACTOR_CLEAN;
    const r = await svc(0).evaluate({ text: 'x' });

    expect(r.decision).toBe('clean');
    expect(r.veto_suppressed).toBeUndefined();
  });

  test('a decision left at vetoed never carries a stale suppression marker', async () => {
    // The execution floor runs AFTER this guard and may re-veto on a deterministic execution
    // failure — evidence that does not need a provider. Whenever the returned decision is
    // 'vetoed', `veto_suppressed` must be absent, or the metadata contradicts the decision.
    (global as any).__fc = EARNED_VETO;
    const r = await svc(2).evaluate({ text: 'x' });

    expect(r.decision).toBe('vetoed');
    expect(r.veto_suppressed).toBeUndefined();
    // The invariant, stated directly.
    expect(r.decision === 'vetoed' && r.veto_suppressed !== undefined).toBe(false);
  });

  test('REVERSIBLE: HAL_VETO_REQUIRES_PROVIDER=false restores the old behaviour', async () => {
    process.env.HAL_VETO_REQUIRES_PROVIDER = 'false';
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(0).evaluate({ text: 'x' });

    expect(r.decision).toBe('vetoed');
    expect(r.veto_suppressed).toBeUndefined();
  });
});
