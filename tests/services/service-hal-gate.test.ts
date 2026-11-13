/**
 * SERVICE_HAL_GATE_MODE (services/service-hal-gate.ts, D-144): a SERVICE_FULFILLED award earns
 * canonical RepID only when HAL actually ran on the deliverable and passed it.
 *
 * Three layers: the pure gate, the live writer (applyServiceFulfilledDeltas, with the score-event
 * writer and the bridge insert captured), and the delta-conformance check that audits the ledger.
 * The off-mode tests are the byte-for-byte guarantee: with the flag unset nothing new is read or
 * written, which is what makes this safe to merge before Sean decides to turn it on.
 */
(global as any).__svcRow = null;
(global as any).__fcImpl = null;
(global as any).__bridgeRows = [];

jest.mock('../../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => ({ hal_score: 0.3, vetoed: false, signals: { comma_severity: null } })),
}));
jest.mock('../../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => (global as any).__fcImpl()),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
  factCheckOptsFromEnv: () => ({ vetoThreshold: 0.5, flagThreshold: 0.35 }),
}));
jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async () => ({})),
  deriveHalDecision: (score: number, vetoed: boolean) => (vetoed ? 'vetoed' : score >= 0.4 ? 'flagged' : 'clean'),
}));
jest.mock('../../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: (global as any).__svcRow, error: null }) }) }) };
      }
      if (table === 'x402_settlements') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_simulated: false }, error: null }) }) }) };
      }
      if (table === 'repid_events') {
        return {
          insert: (row: unknown) => {
            (global as any).__bridgeRows.push(row);
            return { select: () => ({ maybeSingle: async () => ({ data: { id: 'ev-1' }, error: null }) }) };
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
  },
}));

import { gateServiceHal, halGateReason, serviceHalGateMode } from '../../src/services/service-hal-gate';
import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';
import { applyValidationEvent } from '../../src/scoring/pipeline';
import { checkRow } from '../../src/scoring/delta-conformance';

const CONTRACT = { id: 'c-1', service_id: 's-1', provider_agent_id: 'prov-1', buyer_agent_id: 'buyer-1' };
const ENV = ['SERVICE_HAL_GATE_MODE', 'HAL_ENRICHMENT_ENABLED', 'HAL_STRICTNESS', 'SAME_OWNER_SETTLEMENT_MODE'] as const;
const saved: Record<string, string | undefined> = {};
const fc = (decision: 'clean' | 'flagged' | 'vetoed') => () => ({ hal_score: decision === 'clean' ? 0.1 : 0.9, decision, verdicts: [], providers_used: 3, agreement: 1, degraded: false, latency_ms: 5 });
const seed = () => { (global as any).__svcRow = { payload: { content: 'A real deliverable.', title: 'Task', task_type: 'verification' }, metadata: {}, x402_payment_id: 'pay-1' }; };
const calls = () => (applyValidationEvent as jest.Mock).mock.calls as any[][];
const bridge = () => (global as any).__bridgeRows[0];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  (applyValidationEvent as jest.Mock).mockClear();
  (global as any).__bridgeRows = [];
  (global as any).__fcImpl = fc('clean');
  delete process.env.SERVICE_HAL_GATE_MODE;
  delete process.env.SAME_OWNER_SETTLEMENT_MODE;
  process.env.HAL_ENRICHMENT_ENABLED = 'true';
  process.env.HAL_STRICTNESS = '2';
  seed();
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('the pure gate', () => {
  test('a missing verdict is "hal_not_run", never clean: the placeholder D-144 found', () => {
    expect(halGateReason(undefined)).toBe('hal_not_run');
    expect(halGateReason({ hal_score: 0.5, hal_decision: 'clean' })).toBe('hal_not_run'); // no hal_signals = placeholder
    expect(halGateReason({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'fact-check' } })).toBeNull();
    expect(halGateReason({ hal_score: 0.9, hal_decision: 'vetoed', hal_signals: {} })).toBe('vetoed');
    expect(halGateReason({ hal_score: 0.5, hal_decision: 'flagged', hal_signals: {} })).toBe('flagged');
    expect(halGateReason({ hal_score: 0.5, hal_decision: 'abstain', hal_signals: {} })).toBe('abstain');
    expect(halGateReason({ hal_score: 0.5, hal_decision: 'banana', hal_signals: {} })).toBe('unrecognized');
  });

  test('infrastructure is NOT_CHECKED, kept apart from "never ran" and from a verdict', () => {
    expect(halGateReason(undefined, true)).toBe('hal_error');
    expect(halGateReason({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'extractor-fallback' } })).toBe('hal_degraded');
    expect(halGateReason({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'extractor' } })).toBeNull(); // strictness 1 chose the extractor
    // HAL_LOCAL_FALLBACK_ENABLED's keyword guess reports mode 'fact-check', providers_used 1, degraded true (Strix, #1542)
    expect(halGateReason({ hal_score: 0.2, hal_decision: 'clean', hal_signals: { mode: 'fact-check', providers_used: 1, degraded: true } })).toBe('hal_degraded');
    expect(halGateReason({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'fact-check', providers_used: 3, degraded: false } })).toBeNull();
    const e = gateServiceHal({ provider: 10, buyer: 5 }, undefined, 'enforce', true);
    expect(e.provider).toEqual({ delta: 0, meta: { service_hal_gate: { mode: 'enforce', hal_ran: false, would_not_count: 'hal_error', counted: false, ungated_delta: 10 } } });
  });

  test('mode parsing: unset/off are off, a typo is shadow (records, changes nothing), never enforce', () => {
    expect(serviceHalGateMode(undefined)).toBe('off');
    expect(serviceHalGateMode(' OFF ')).toBe('off');
    expect(serviceHalGateMode('shadow')).toBe('shadow');
    expect(serviceHalGateMode('Enforce')).toBe('enforce');
    expect(serviceHalGateMode('enforced')).toBe('shadow');
  });

  test('off returns the deltas untouched with no metadata; shadow tags; enforce withholds, never subtracts', () => {
    const veto = { hal_score: 0.9, hal_decision: 'vetoed', hal_signals: {} };
    expect(gateServiceHal({ provider: 10, buyer: 5 }, veto, 'off')).toEqual({ provider: { delta: 10, meta: {} }, buyer: { delta: 5, meta: {} } });
    const s = gateServiceHal({ provider: 10, buyer: 5 }, veto, 'shadow');
    expect([s.provider.delta, s.buyer.delta]).toEqual([10, 5]);
    expect(s.provider.meta.service_hal_gate).toEqual({ mode: 'shadow', hal_ran: true, would_not_count: 'vetoed', counted: true, ungated_delta: 10 });
    const e = gateServiceHal({ provider: 10, buyer: 5 }, veto, 'enforce');
    expect([e.provider.delta, e.buyer.delta]).toEqual([0, 0]);
    expect(e.buyer.meta.service_hal_gate).toEqual({ mode: 'enforce', hal_ran: true, would_not_count: 'vetoed', counted: false, ungated_delta: 5 });
    const ok = gateServiceHal({ provider: 10, buyer: 5 }, { hal_score: 0.1, hal_decision: 'clean', hal_signals: {} }, 'enforce');
    expect([ok.provider.delta, ok.buyer.delta, ok.provider.meta.service_hal_gate?.counted]).toEqual([10, 5, true]);
  });
});

describe('the live writer: applyServiceFulfilledDeltas', () => {
  test('flag unset: +10/+5, no service_hal_gate key, bridge row without skip keys (byte-for-byte today)', async () => {
    (global as any).__fcImpl = fc('vetoed'); // even a veto changes nothing while the gate is off
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls().map((c) => c[2])).toEqual([10, 5]);
    for (const c of calls()) expect(c[3]).not.toHaveProperty('service_hal_gate');
    expect(bridge().reputation_delta).toBe(10);
    expect(bridge()).not.toHaveProperty('processed_at');
    expect(bridge().event_data).not.toHaveProperty('onchain_skipped');
    expect(bridge().event_data).not.toHaveProperty('onchain_would_skip');
  });

  test('shadow + veto: the numbers do not move, the rows say what enforce would do', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'shadow';
    (global as any).__fcImpl = fc('vetoed');
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls().map((c) => c[2])).toEqual([10, 5]);
    expect(calls()[0][3].service_hal_gate).toMatchObject({ mode: 'shadow', would_not_count: 'vetoed', counted: true });
    expect(bridge().event_data.onchain_would_skip).toBe('vetoed');
    expect(bridge()).not.toHaveProperty('processed_at');
  });

  test('enforce + veto: both sides earn 0, the on-chain write is skipped, the HAL verdict still reaches the ledger', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'enforce';
    (global as any).__fcImpl = fc('vetoed');
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls().map((c) => c[2])).toEqual([0, 0]);
    expect(calls()[0][3].service_hal_gate).toEqual({ mode: 'enforce', hal_ran: true, would_not_count: 'vetoed', counted: false, ungated_delta: 10 });
    expect(calls()[0][4].hal_decision).toBe('vetoed');
    expect(bridge().reputation_delta).toBe(0);
    expect(bridge().event_data.onchain_skipped).toBe('vetoed');
    expect(typeof bridge().processed_at).toBe('string');
  });

  test('enforce + HAL never ran: withheld as hal_not_run, not credited as the "clean" placeholder', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'enforce';
    delete process.env.HAL_ENRICHMENT_ENABLED;
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls()[0][4]).toBeUndefined(); // applyValidationEvent would write 'clean'/0.5 here
    expect(calls().map((c) => c[2])).toEqual([0, 0]);
    expect(calls()[0][3].service_hal_gate).toMatchObject({ hal_ran: false, would_not_count: 'hal_not_run' });
  });

  test('enforce + HAL throws: withheld as hal_error (nothing assessed), not as a verdict', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'enforce';
    (global as any).__fcImpl = () => { throw new Error('provider outage'); };
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls().map((c) => c[2])).toEqual([0, 0]);
    expect(calls()[0][3].service_hal_gate).toMatchObject({ hal_ran: false, would_not_count: 'hal_error', ungated_delta: 10 });
    expect(bridge().event_data.onchain_skipped).toBe('hal_error');
  });

  test('enforce + no fact-check provider answered: the extractor fallback\'s "clean" is withheld as hal_degraded', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'enforce';
    (global as any).__fcImpl = () => ({ ...fc('clean')(), providers_used: 0 });
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls()[0][4].hal_signals.mode).toBe('extractor-fallback');
    expect(calls().map((c) => c[2])).toEqual([0, 0]);
    expect(calls()[0][3].service_hal_gate).toMatchObject({ hal_ran: true, would_not_count: 'hal_degraded' });
  });

  test('enforce + clean: earns in full, nothing skipped', async () => {
    process.env.SERVICE_HAL_GATE_MODE = 'enforce';
    await applyServiceFulfilledDeltas(CONTRACT);
    expect(calls().map((c) => c[2])).toEqual([10, 5]);
    expect(calls()[1][3].service_hal_gate).toMatchObject({ counted: true, would_not_count: null });
    expect(bridge().reputation_delta).toBe(10);
    expect(bridge()).not.toHaveProperty('processed_at');
  });
});

describe('the ledger audit: delta-conformance', () => {
  const row = (delta: number, meta: Record<string, unknown>) => ({ id: 1, event_type: 'SERVICE_FULFILLED', delta, repid_before: 100, repid_after: 100 + delta, repid_delta_applied: delta, metadata: { role: 'provider', ...meta } });
  const verdict = (r: ReturnType<typeof row>) => checkRow(r as any).find((x) => x.check === 'A2A_FULFILLED');

  test('a row the HAL gate withheld conforms at 0', () => {
    expect(verdict(row(0, { service_hal_gate: { mode: 'enforce', hal_ran: true, would_not_count: 'vetoed', counted: false, ungated_delta: 10 } }))?.status).toBe('CONFORMS');
  });
  test('control: a 0 with no withhold tag still deviates', () => {
    expect(verdict(row(0, {}))?.status).toBe('DEVIATES');
  });
  test('control: a shadow tag (counted) does not excuse a 0', () => {
    expect(verdict(row(0, { service_hal_gate: { mode: 'shadow', hal_ran: true, would_not_count: 'vetoed', counted: true, ungated_delta: 10 } }))?.status).toBe('DEVIATES');
  });
});
