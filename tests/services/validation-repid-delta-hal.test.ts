/**
 * HAL enrichment integration — applyServiceFulfilledDeltas.
 * strictness:1 = extractor (evaluate); strictness:2 = fact-check evaluator.
 * Mocks evaluate/factCheck/applyValidationEvent/db so we assert the halOverride
 * passed into the SERVICE_FULFILLED calls without network/Supabase. Bridge
 * insert is byte-verified untouched (separate diff check).
 */

(global as any).__svcRow = null;
(global as any).__evalImpl = null;
(global as any).__fcImpl = null;

jest.mock('../../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => {
    const impl = (global as any).__evalImpl;
    if (typeof impl === 'function') return impl();
    return { hal_score: 0.3, vetoed: false, signals: { harm_probability: 0.1, comma_severity: null } };
  }),
}));

jest.mock('../../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => {
    const impl = (global as any).__fcImpl;
    if (typeof impl === 'function') return impl();
    return { hal_score: 0.1, decision: 'clean', verdicts: [{ provider: 'groq', verdict: 'TRUE', confidence: 100 }], providers_used: 3, agreement: 1, degraded: false, latency_ms: 5 };
  }),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
  factCheckOptsFromEnv: () => ({ vetoThreshold: 0.5, flagThreshold: 0.35 }),
}));

jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async () => ({})),
  deriveHalDecision: (score: number, vetoed: boolean, sev?: string | null) =>
    vetoed || sev === 'critical' ? 'vetoed' : score >= 0.4 ? 'flagged' : 'clean',
}));

jest.mock('../../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: (global as any).__svcRow, error: null }) }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }) };
    },
  },
}));

import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';
import { applyValidationEvent } from '../../src/scoring/pipeline';
import { evaluate } from '../../src/hal/lib/evaluate';
import { factCheck } from '../../src/hal/fact-check';

const CONTRACT = { id: 'c-1', service_id: 's-1', provider_agent_id: 'prov-1', buyer_agent_id: 'buyer-1' };
const seedReal = () => { (global as any).__svcRow = { payload: { content: 'A real deliverable to score.', title: 'Task', task_type: 'verification' }, metadata: {}, x402_payment_id: null }; };

beforeEach(() => {
  (applyValidationEvent as jest.Mock).mockClear();
  (evaluate as jest.Mock).mockClear();
  (factCheck as jest.Mock).mockClear();
  (global as any).__svcRow = null;
  (global as any).__evalImpl = null;
  (global as any).__fcImpl = null;
  process.env.HAL_ENRICHMENT_ENABLED = 'true';
  delete process.env.HAL_STRICTNESS;
});
afterEach(() => { delete process.env.HAL_ENRICHMENT_ENABLED; delete process.env.HAL_STRICTNESS; });

describe('HAL_ENRICHMENT_ENABLED gate', () => {
  test('OFF (unset) → no eval, no factCheck, halOverride undefined (legacy)', async () => {
    seedReal(); delete process.env.HAL_ENRICHMENT_ENABLED;
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][4]).toBeUndefined();
    expect(calls[1][4]).toBeUndefined();
  });

  test('OFF ("false") → skipped', async () => {
    seedReal(); process.env.HAL_ENRICHMENT_ENABLED = 'false';
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4]).toBeUndefined();
  });
});

describe('strictness:1 (extractor, default)', () => {
  test('ON + default → evaluate used, fact-check NOT, mode=extractor passed to both', async () => {
    seedReal();
    (global as any).__evalImpl = () => ({ hal_score: 0.3, vetoed: false, signals: { harm_probability: 0.1, comma_severity: null } });
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    const o = (applyValidationEvent as jest.Mock).mock.calls[0][4];
    expect(o.hal_score).toBe(0.3);
    expect(o.hal_decision).toBe('clean');
    expect(o.hal_signals.mode).toBe('extractor');
    expect((applyValidationEvent as jest.Mock).mock.calls[1][4]).toEqual(o); // both calls same override
  });
});

describe('strictness:2 (fact-check)', () => {
  test('=2 → factCheck used, evaluate NOT; fc result becomes halOverride', async () => {
    seedReal(); process.env.HAL_STRICTNESS = '2';
    (global as any).__fcImpl = () => ({ hal_score: 0.9, decision: 'vetoed', verdicts: [{ provider: 'groq', verdict: 'FALSE', confidence: 100 }], providers_used: 3, agreement: 1, degraded: false, latency_ms: 7 });
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    const o = (applyValidationEvent as jest.Mock).mock.calls[0][4];
    expect(o.hal_score).toBe(0.9);
    expect(o.hal_decision).toBe('vetoed');
    expect(o.hal_signals.mode).toBe('fact-check');
    expect(o.hal_signals.providers_used).toBe(3);
    expect(o.hal_signals.verdicts[0].verdict).toBe('FALSE');
  });

  test('=2 clean deliverable → fc clean → not vetoed', async () => {
    seedReal(); process.env.HAL_STRICTNESS = '2';
    (global as any).__fcImpl = () => ({ hal_score: 0.1, decision: 'clean', verdicts: [], providers_used: 3, agreement: 1, degraded: false, latency_ms: 5 });
    await applyServiceFulfilledDeltas(CONTRACT);
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4].hal_decision).toBe('clean');
  });

  test('=2 but 0 providers respond → extractor fallback (mode=extractor-fallback)', async () => {
    seedReal(); process.env.HAL_STRICTNESS = '2';
    (global as any).__fcImpl = () => ({ hal_score: 0.5, decision: 'flagged', verdicts: [], providers_used: 0, agreement: null, degraded: true, latency_ms: 30 });
    (global as any).__evalImpl = () => ({ hal_score: 0.3, vetoed: false, signals: {} });
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1); // fallback
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4].hal_signals.mode).toBe('extractor-fallback');
  });

  test('=2 factCheck throws → non-fatal, halOverride undefined, fulfillment completes', async () => {
    seedReal(); process.env.HAL_STRICTNESS = '2';
    (global as any).__fcImpl = () => { throw new Error('fc blew up'); };
    await expect(applyServiceFulfilledDeltas(CONTRACT)).resolves.toBeUndefined();
    const calls = (applyValidationEvent as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][4]).toBeUndefined();
  });
});

describe('skip conditions', () => {
  test('simulated → no eval/factCheck, undefined', async () => {
    (global as any).__svcRow = { payload: { content: 'x' }, metadata: { is_simulated: true }, x402_payment_id: null };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect((applyValidationEvent as jest.Mock).mock.calls[0][4]).toBeUndefined();
  });

  test('empty deliverable → skipped', async () => {
    (global as any).__svcRow = { payload: { content: '   ' }, metadata: {}, x402_payment_id: null };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
  });
});
