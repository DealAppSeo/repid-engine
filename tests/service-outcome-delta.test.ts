/**
 * T3 — delayed outcome signal, delta-logic unit tests.
 *
 * Covers the pure rater-weight math + the good/ok/bad delta signs + rater-weight
 * scaling + absence-neutrality (ok → no score event). applyValidationEvent is
 * mocked so we assert exactly what delta the provider WOULD receive without
 * touching the DB.
 */

// Avoid the src/config → src/db boot check (needs SUPABASE_* env). The outcome
// delta path only touches applyValidationEvent (mocked below), never db directly.
jest.mock('../src/db', () => ({ db: {} }));

// Capture the calls the outcome path makes into applyValidationEvent.
const calls: Array<{ agent_id: string; event_type: string; delta: number; metadata: any }> = [];

jest.mock('../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async (agent_id: string, event_type: string, delta: number, metadata: any) => {
    calls.push({ agent_id, event_type, delta, metadata });
    return { old_repid: 1000, new_repid: 1000 + delta, delta_applied: delta };
  }),
  // deriveHalDecision is imported at module top of validation-repid-delta; stub it.
  deriveHalDecision: jest.fn(() => 'clean'),
}));

import { computeRaterWeight, applyServiceOutcomeDeltas } from '../src/services/validation-repid-delta';

const CONTRACT = {
  id: 'contract-1',
  provider_agent_id: 'provider-1',
  buyer_agent_id: 'buyer-1',
  service_id: 'service-1',
};

beforeEach(() => {
  calls.length = 0;
});

describe('computeRaterWeight — clamp(repid/1000, 0.25, 2.0)', () => {
  test('baseline ESTABLISHED rater (1000) → ~1.0', () => {
    expect(computeRaterWeight(1000)).toBeCloseTo(1.0, 5);
  });
  test('fresh/zero rater floors at 0.25', () => {
    expect(computeRaterWeight(0)).toBe(0.25);
    expect(computeRaterWeight(50)).toBe(0.25); // 0.05 < min
  });
  test('maxed rater ceils at 2.0', () => {
    expect(computeRaterWeight(10000)).toBe(2.0);
    expect(computeRaterWeight(2500)).toBe(2.0); // 2.5 > max
  });
  test('mid rater scales linearly (1500 → 1.5)', () => {
    expect(computeRaterWeight(1500)).toBeCloseTo(1.5, 5);
  });
  test('null/undefined/NaN rater floors safely at 0.25', () => {
    expect(computeRaterWeight(null)).toBe(0.25);
    expect(computeRaterWeight(undefined)).toBe(0.25);
    expect(computeRaterWeight(NaN)).toBe(0.25);
  });
});

describe('applyServiceOutcomeDeltas — good/ok/bad signs', () => {
  test('good → positive provider delta, no dispute flag', async () => {
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'good', 1000);
    expect(r.providerDelta).toBeGreaterThan(0);
    expect(r.disputeEligible).toBe(false);
    expect(r.scoreEventApplied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event_type).toBe('SERVICE_OUTCOME');
    expect(calls[0]!.agent_id).toBe('provider-1'); // provider only
    expect(calls[0]!.delta).toBe(r.providerDelta);
  });

  test('bad → negative provider delta AND dispute-eligible flag (no auto-dispute)', async () => {
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 1000);
    expect(r.providerDelta).toBeLessThan(0);
    expect(r.disputeEligible).toBe(true);
    expect(r.scoreEventApplied).toBe(true);
  });

  test('ok → ~0 delta and NO score event (honest neutral middle)', async () => {
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'ok', 1000);
    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(r.disputeEligible).toBe(false);
    expect(calls).toHaveLength(0); // absence-neutral: no move → no event
  });

  test('bad outweighs good in base magnitude (largest-weight touchpoint)', async () => {
    const good = await applyServiceOutcomeDeltas(CONTRACT, 'good', 1000);
    const bad = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 1000);
    expect(Math.abs(bad.baseDelta)).toBeGreaterThanOrEqual(Math.abs(good.baseDelta));
  });
});

describe('applyServiceOutcomeDeltas — rater-weight scaling', () => {
  test('higher-rep rater moves the provider MORE (good)', async () => {
    const lowRep = await applyServiceOutcomeDeltas(CONTRACT, 'good', 500);   // weight 0.5
    const highRep = await applyServiceOutcomeDeltas(CONTRACT, 'good', 2000); // weight 2.0
    expect(highRep.providerDelta).toBeGreaterThan(lowRep.providerDelta);
    expect(highRep.raterWeight).toBeGreaterThan(lowRep.raterWeight);
  });

  test('rater-weight is applied multiplicatively (good @2.0× == 2× the @1.0× delta)', async () => {
    const base = await applyServiceOutcomeDeltas(CONTRACT, 'good', 1000); // 1.0×
    const doubled = await applyServiceOutcomeDeltas(CONTRACT, 'good', 2000); // 2.0×
    expect(doubled.providerDelta).toBe(base.providerDelta * 2);
  });

  test('bad delta magnitude also scales with rater weight', async () => {
    const lowRep = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 500);
    const highRep = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 2000);
    expect(highRep.providerDelta).toBeLessThan(lowRep.providerDelta); // more negative
  });
});
