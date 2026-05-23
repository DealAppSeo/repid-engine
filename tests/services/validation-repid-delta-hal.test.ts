/**
 * HAL Enrichment Phase 2 — applyServiceFulfilledDeltas wires real HAL.
 *
 * Mocks evaluate(), applyValidationEvent(), and db so we can assert the
 * halOverride passed into the SERVICE_FULFILLED score-event calls, without
 * touching Supabase or the (byte-verified) bridge insert.
 */

(global as any).__svcRow = null;
(global as any).__evalImpl = null;

jest.mock('../../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async (...args: any[]) => {
    const impl = (global as any).__evalImpl;
    if (typeof impl === 'function') return impl(...args);
    return { hal_score: 0.5, vetoed: false, signals: {} };
  }),
}));

jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async () => ({})),
  // Real deriveHalDecision logic (pipeline.ts:69).
  deriveHalDecision: (score: number, vetoed: boolean, sev?: string | null) =>
    vetoed || sev === 'critical' ? 'vetoed' : score >= 0.4 ? 'flagged' : 'clean',
}));

jest.mock('../../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: (global as any).__svcRow, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
  },
}));

import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';
import { applyValidationEvent } from '../../src/scoring/pipeline';
import { evaluate } from '../../src/hal/lib/evaluate';

const CONTRACT = {
  id: 'c-1',
  service_id: 's-1',
  provider_agent_id: 'prov-1',
  buyer_agent_id: 'buyer-1',
};

beforeEach(() => {
  (applyValidationEvent as jest.Mock).mockClear();
  (evaluate as jest.Mock).mockClear();
  (global as any).__svcRow = null;
  (global as any).__evalImpl = null;
  process.env.HAL_ENRICHMENT_ENABLED = 'true'; // existing tests exercise the ENABLED path
  delete process.env.HAL_STRICTNESS;            // default strictness:1 unless a test overrides
});

afterEach(() => {
  delete process.env.HAL_ENRICHMENT_ENABLED;
  delete process.env.HAL_STRICTNESS;
});

describe('applyServiceFulfilledDeltas — HAL enrichment', () => {
  test('1. clean deliverable → HAL evaluated → real hal passed as halOverride to both calls', async () => {
    (global as any).__svcRow = {
      payload: { content: 'A thorough verified deliverable about X.', title: 'Task X', task_type: 'verification' },
      metadata: {},
      x402_payment_id: null, // bridge insert skipped (not under test here)
    };
    (global as any).__evalImpl = async () => ({
      hal_score: 0.7,
      vetoed: false,
      signals: { harm_probability: 0.6, comma_severity: null },
    });

    await applyServiceFulfilledDeltas(CONTRACT);

    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    // strictness:1 (MVP, extractor-only) confirmed
    expect((evaluate as jest.Mock).mock.calls[0][2]).toMatchObject({ strictness: 1 });

    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2); // provider + buyer
    const providerOverride = calls[0][4];
    const buyerOverride = calls[1][4];
    expect(providerOverride).toEqual({ hal_score: 0.7, hal_decision: 'flagged', hal_signals: { harm_probability: 0.6, comma_severity: null } });
    expect(buyerOverride).toEqual(providerOverride);
    // event_type + deltas unchanged
    expect(calls[0][1]).toBe('SERVICE_FULFILLED');
    expect(calls[0][2]).toBe(10);
    expect(calls[1][2]).toBe(5);
  });

  test('2. simulated contract → HAL skipped → halOverride undefined (default 0.5/clean)', async () => {
    (global as any).__svcRow = {
      payload: { content: 'whatever', title: 't' },
      metadata: { is_simulated: true },
      x402_payment_id: null,
    };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][4]).toBeUndefined();
    expect(calls[1][4]).toBeUndefined();
  });

  test('3. HAL throws → falls back to default, fulfillment still completes', async () => {
    (global as any).__svcRow = {
      payload: { content: 'real deliverable text', title: 't' },
      metadata: {},
      x402_payment_id: null,
    };
    (global as any).__evalImpl = async () => {
      throw new Error('hal blew up');
    };
    await expect(applyServiceFulfilledDeltas(CONTRACT)).resolves.toBeUndefined();
    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2); // fulfillment still ran
    expect(calls[0][4]).toBeUndefined(); // fell back to default
  });

  test('4. empty deliverable → HAL skipped, default used', async () => {
    (global as any).__svcRow = {
      payload: { content: '   ', title: 't' },
      metadata: {},
      x402_payment_id: null,
    };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4]).toBeUndefined();
  });

  test('5. vetoed deliverable → hal_decision vetoed propagated', async () => {
    (global as any).__svcRow = {
      payload: { content: 'a confidently false fabricated claim', title: 't' },
      metadata: {},
      x402_payment_id: null,
    };
    (global as any).__evalImpl = async () => ({
      hal_score: 0.9,
      vetoed: true,
      signals: { comma_severity: 'critical' },
    });
    await applyServiceFulfilledDeltas(CONTRACT);
    const override = (applyValidationEvent as jest.Mock).mock.calls[0][4];
    expect(override.hal_decision).toBe('vetoed');
    expect(override.hal_score).toBe(0.9);
  });
});

describe('applyServiceFulfilledDeltas — HAL_ENRICHMENT_ENABLED gate (Phase 1)', () => {
  const seedRealContract = () => {
    (global as any).__svcRow = {
      payload: { content: 'A real verified deliverable about X.', title: 'Task X', task_type: 'verification' },
      metadata: {},
      x402_payment_id: null,
    };
    (global as any).__evalImpl = async () => ({ hal_score: 0.3, vetoed: false, signals: {} });
  };

  test('gate OFF (unset) → HAL skipped, halOverride undefined (0.5/clean legacy)', async () => {
    seedRealContract();
    delete process.env.HAL_ENRICHMENT_ENABLED;
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2); // fulfillment still runs
    expect(calls[0][4]).toBeUndefined(); // no override → applyValidationEvent uses 0.5/clean
    expect(calls[1][4]).toBeUndefined();
  });

  test('gate OFF (="false") → HAL skipped', async () => {
    seedRealContract();
    process.env.HAL_ENRICHMENT_ENABLED = 'false';
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4]).toBeUndefined();
  });

  test('gate ON (="true") → HAL runs → halOverride populated', async () => {
    seedRealContract();
    process.env.HAL_ENRICHMENT_ENABLED = 'true';
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4]).toMatchObject({ hal_score: 0.3, hal_decision: 'clean' });
  });
});
