/**
 * Simulation gate — ALL four contract touchpoints (2026-07-29).
 *
 * The known F1 finding (2026-05-27 CC2_MARKETPLACE_DEMO): T1
 * (applyServiceFulfilledDeltas) gated RepID deltas on simulated contracts, but
 * T2 (applyServiceSatisfiedDeltas), T3 (applyServiceOutcomeDeltas), and
 * applyServiceDisputeResolution did not — simulated contracts moved real RepID
 * via /satisfy, /outcome, and dispute resolution (−100 provider observed in
 * production). These tests pin the shared gate (contractRowIsSimulated /
 * isContractSimulated) across every path, mirroring the F-series variant
 * matrix in tests/workers/is-simulated-gate.test.ts.
 */

(global as any).__svcRow = null;
(global as any).__svcErr = null;
(global as any).__settlementRow = null;

jest.mock('../../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: (global as any).__svcRow, error: (global as any).__svcErr }),
            }),
          }),
        };
      }
      if (table === 'x402_settlements') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: (global as any).__settlementRow, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  },
}));

jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async () => ({})),
  deriveHalDecision: () => 'clean',
}));

jest.mock('../../src/services/onchain-reputation-trigger', () => ({
  maybeWriteOnChainReputation: jest.fn(async () => ({ attempted: false })),
}));

import {
  applyServiceFulfilledDeltas,
  applyServiceSatisfiedDeltas,
  applyServiceOutcomeDeltas,
  applyServiceDisputeResolution,
  isContractSimulated,
} from '../../src/services/validation-repid-delta';
import { applyValidationEvent } from '../../src/scoring/pipeline';

const CONTRACT = { id: 'c-1', service_id: 's-1', provider_agent_id: 'prov-1', buyer_agent_id: 'buyer-1' };

const seedRow = (row: any) => { (global as any).__svcRow = row; };
const realRow = () => seedRow({ metadata: {}, payload: {}, x402_payment_id: null });
const simRow = () => seedRow({ metadata: { is_simulated: true }, payload: {}, x402_payment_id: null });

const deltaCalls = () => (applyValidationEvent as jest.Mock).mock.calls;

beforeEach(() => {
  (applyValidationEvent as jest.Mock).mockClear();
  (global as any).__svcRow = null;
  (global as any).__svcErr = null;
  (global as any).__settlementRow = null;
});

// ── Shared helper: F-series variant matrix (mirrors is-simulated-gate.test.ts) ──

describe('isContractSimulated — F-series truthy variants MUST gate', () => {
  const TRUTHY: [string, any][] = [
    ['metadata bool true', { metadata: { is_simulated: true }, payload: {}, x402_payment_id: null }],
    ['metadata "true"', { metadata: { is_simulated: 'true' }, payload: {}, x402_payment_id: null }],
    ['metadata "True" (F1)', { metadata: { is_simulated: 'True' }, payload: {}, x402_payment_id: null }],
    ['metadata "TRUE" (F1)', { metadata: { is_simulated: 'TRUE' }, payload: {}, x402_payment_id: null }],
    ['metadata int 1 (F2)', { metadata: { is_simulated: 1 }, payload: {}, x402_payment_id: null }],
    ['metadata "1" (F2)', { metadata: { is_simulated: '1' }, payload: {}, x402_payment_id: null }],
    ['metadata "yes" (F2)', { metadata: { is_simulated: 'yes' }, payload: {}, x402_payment_id: null }],
    ['metadata nested (F4)', { metadata: { flags: { is_simulated: true } }, payload: {}, x402_payment_id: null }],
    ['payload flag', { metadata: {}, payload: { is_simulated: true }, x402_payment_id: null }],
    ['payload nested (F4)', { metadata: {}, payload: { inner: { is_simulated: 'yes' } }, x402_payment_id: null }],
  ];
  test.each(TRUTHY)('%s -> simulated', async (_label, row) => {
    seedRow(row);
    expect(await isContractSimulated('c-1')).toBe(true);
  });

  const FALSY: [string, any][] = [
    ['bool false', { metadata: { is_simulated: false }, payload: {}, x402_payment_id: null }],
    ['"false"', { metadata: { is_simulated: 'false' }, payload: {}, x402_payment_id: null }],
    ['int 0', { metadata: { is_simulated: 0 }, payload: {}, x402_payment_id: null }],
    ['"no"', { metadata: { is_simulated: 'no' }, payload: {}, x402_payment_id: null }],
    ['absent', { metadata: {}, payload: {}, x402_payment_id: null }],
    ['null metadata/payload', { metadata: null, payload: null, x402_payment_id: null }],
  ];
  test.each(FALSY)('%s -> NOT simulated', async (_label, row) => {
    seedRow(row);
    expect(await isContractSimulated('c-1')).toBe(false);
  });

  test('linked x402 settlement is_simulated=true -> simulated', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: true };
    expect(await isContractSimulated('c-1')).toBe(true);
  });

  test('linked x402 settlement is_simulated=false -> NOT simulated', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: false };
    expect(await isContractSimulated('c-1')).toBe(false);
  });

  test('contract fetch error -> fails OPEN (not simulated) so a DB blip cannot zero a real delta', async () => {
    (global as any).__svcErr = { message: 'transient boom' };
    expect(await isContractSimulated('c-1')).toBe(false);
  });
});

// ── T1 regression: refactor to the shared helper preserved the existing gate ──

describe('T1 applyServiceFulfilledDeltas — gate preserved after shared-helper refactor', () => {
  test('real contract -> provider +10 / buyer +5', async () => {
    realRow();
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][2]).toBe(10);
    expect(deltaCalls()[1][2]).toBe(5);
  });

  test('simulated contract -> both SERVICE_FULFILLED events written with delta 0', async () => {
    simRow();
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][2]).toBe(0);
    expect(deltaCalls()[1][2]).toBe(0);
  });

  test('simulated via x402 settlement -> delta 0', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: true };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][2]).toBe(0);
    expect(deltaCalls()[1][2]).toBe(0);
  });
});

// ── T2: /satisfy — the first previously-ungated path ──

describe('T2 applyServiceSatisfiedDeltas — simulation gate (mirrors T1)', () => {
  test('real contract, score 0.8 -> provider +24 / buyer +12', async () => {
    realRow();
    await applyServiceSatisfiedDeltas(CONTRACT, 0.8);
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][1]).toBe('SERVICE_SATISFIED');
    expect(deltaCalls()[0][2]).toBe(24);
    expect(deltaCalls()[1][2]).toBe(12);
  });

  test('simulated contract, score 1.0 -> both events written with delta 0 (audit kept, no RepID move)', async () => {
    simRow();
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][2]).toBe(0);
    expect(deltaCalls()[1][2]).toBe(0);
  });

  test('simulated via x402 settlement -> delta 0', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: true };
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    expect(deltaCalls()[0][2]).toBe(0);
    expect(deltaCalls()[1][2]).toBe(0);
  });

  test('contract fetch error -> fails open, real deltas still apply', async () => {
    (global as any).__svcErr = { message: 'transient boom' };
    await applyServiceSatisfiedDeltas(CONTRACT, 0.8);
    expect(deltaCalls()[0][2]).toBe(24);
    expect(deltaCalls()[1][2]).toBe(12);
  });
});

// ── T3: /outcome — rater-weighted provider delta ──

describe('T3 applyServiceOutcomeDeltas — simulation gate (mirrors T1)', () => {
  test('real contract, good @ rater 1000 -> provider +60, score event applied', async () => {
    realRow();
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'good', 1000);
    expect(r.providerDelta).toBe(60);
    expect(r.scoreEventApplied).toBe(true);
    expect(deltaCalls().length).toBe(1);
    expect(deltaCalls()[0][1]).toBe('SERVICE_OUTCOME');
  });

  test('simulated contract, good -> delta 0, NO score event', async () => {
    simRow();
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'good', 1000);
    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(deltaCalls().length).toBe(0);
  });

  test('simulated contract, bad -> delta 0, no event; disputeEligible flag unchanged', async () => {
    simRow();
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 2000);
    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(r.disputeEligible).toBe(true);
    expect(deltaCalls().length).toBe(0);
  });

  test('simulated via x402 settlement, bad -> delta 0', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: true };
    const r = await applyServiceOutcomeDeltas(CONTRACT, 'bad', 1000);
    expect(r.providerDelta).toBe(0);
    expect(deltaCalls().length).toBe(0);
  });
});

// ── Dispute resolution — the exact path of the 2026-05-27 production leak ──

describe('applyServiceDisputeResolution — simulation gate (mirrors T1)', () => {
  test('real contract, provider_at_fault -> provider −100 / buyer +20', async () => {
    realRow();
    await applyServiceDisputeResolution(CONTRACT, 'provider_at_fault');
    expect(deltaCalls().length).toBe(2);
    expect(deltaCalls()[0][2]).toBe(-100);
    expect(deltaCalls()[0][1]).toBe('VALIDATION_FAILED');
    expect(deltaCalls()[1][2]).toBe(20);
    expect(deltaCalls()[1][1]).toBe('SERVICE_FULFILLED');
  });

  test('simulated contract, provider_at_fault -> NO deltas (the historical −100 leak)', async () => {
    simRow();
    await applyServiceDisputeResolution(CONTRACT, 'provider_at_fault');
    expect(deltaCalls().length).toBe(0);
  });

  test('simulated contract, buyer_at_fault -> NO deltas', async () => {
    simRow();
    await applyServiceDisputeResolution(CONTRACT, 'buyer_at_fault');
    expect(deltaCalls().length).toBe(0);
  });

  test('simulated via x402 settlement -> NO deltas', async () => {
    seedRow({ metadata: {}, payload: {}, x402_payment_id: 'pay-1' });
    (global as any).__settlementRow = { is_simulated: true };
    await applyServiceDisputeResolution(CONTRACT, 'provider_at_fault');
    expect(deltaCalls().length).toBe(0);
  });

  test('real contract, no_fault -> no deltas (both 0 by matrix, unchanged)', async () => {
    realRow();
    await applyServiceDisputeResolution(CONTRACT, 'no_fault');
    expect(deltaCalls().length).toBe(0);
  });
});
