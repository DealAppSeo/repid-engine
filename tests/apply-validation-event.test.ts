/**
 * HAL Enrichment Phase 1 — applyValidationEvent halOverride param tests.
 *
 * Mocks src/db + src/services/auditChainWriter so the function runs without
 * touching Supabase. Verifies:
 *   1. No halOverride  → 0.5 / 'clean' / decision_outcome 'clean' (backward compat)
 *   2. With halOverride → provided hal_score / hal_decision / decision_outcome
 *   3. SERVICE_FULFILLED + halOverride → audit-chain anchor carries real HAL
 *   4. hal_signals roundtrips into metadata.hal_signals
 */

(global as any).__avAgentRow = null;
(global as any).__avInsertCalls = [];
(global as any).__avUpdateCalls = [];
(global as any).__avAnchorCalls = [];
// Prevent the best-effort ZK proof-queue fetch from making a real network call.
(global as any).fetch = async () => ({ ok: true, json: async () => ({}) });

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => {
      if (tableName === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: (global as any).__avAgentRow ?? null,
                error: (global as any).__avAgentRow ? null : { message: 'not found' },
              }),
            }),
          }),
          update: (payload: any) => ({
            eq: () => {
              (global as any).__avUpdateCalls.push(payload);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      if (tableName === 'repid_score_events') {
        return {
          // shouldTriggerProof count chain (only hit when |delta| < 5)
          select: (_cols?: string, opts?: any) => ({
            eq: () => ({
              then: (resolve: any) =>
                resolve({ data: null, error: null, count: opts && opts.head ? 0 : null }),
            }),
          }),
          insert: (payload: any) => ({
            select: () => ({
              single: async () => {
                (global as any).__avInsertCalls.push(payload);
                return { data: { id: 4242 }, error: null };
              },
            }),
          }),
        };
      }
      if (tableName === 'repid_proof_queue') {
        return { insert: () => Promise.resolve({ data: null, error: null }) };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/services/auditChainWriter', () => ({
  appendToAuditChain: async (_table: string, _id: string, payload: any) => {
    (global as any).__avAnchorCalls.push(payload);
    return { ok: true };
  },
}));

import { applyValidationEvent } from '../src/scoring/pipeline';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  (global as any).__avAgentRow = {
    id: AGENT_ID,
    current_repid: 1000,
    tier: 'ESTABLISHED',
    vesting_cliff_ends_at: null,
  };
  (global as any).__avInsertCalls = [];
  (global as any).__avUpdateCalls = [];
  (global as any).__avAnchorCalls = [];
});

describe('applyValidationEvent — halOverride', () => {
  test('1. no halOverride → 0.5 / clean / decision_outcome clean (backward compat)', async () => {
    await applyValidationEvent(AGENT_ID, 'VALIDATOR_REWARD', 10, { role: 'validator' });
    expect((global as any).__avInsertCalls.length).toBe(1);
    const row = (global as any).__avInsertCalls[0];
    expect(row.hal_score).toBe(0.5);
    expect(row.hal_decision).toBe('clean');
    expect(row.decision_outcome).toBe('clean');
    expect(row.event_type).toBe('VALIDATOR_REWARD');
    expect(row.delta).toBe(10);
    // metadata untouched (no hal_signals injected)
    expect(row.metadata.hal_signals).toBeUndefined();
    expect(row.metadata.role).toBe('validator');
  });

  test('2. with halOverride → provided hal_score / hal_decision / decision_outcome', async () => {
    await applyValidationEvent(AGENT_ID, 'SERVICE_FULFILLED', 10, { role: 'provider' }, {
      hal_score: 0.82,
      hal_decision: 'flagged',
    });
    const row = (global as any).__avInsertCalls[0];
    expect(row.hal_score).toBe(0.82);
    expect(row.hal_decision).toBe('flagged');
    expect(row.decision_outcome).toBe('flagged');
  });

  test('3. SERVICE_FULFILLED + halOverride → audit anchor carries real HAL', async () => {
    await applyValidationEvent(AGENT_ID, 'SERVICE_FULFILLED', 10, { role: 'provider', contract_id: 'c-1' }, {
      hal_score: 0.71,
      hal_decision: 'flagged',
    });
    expect((global as any).__avAnchorCalls.length).toBe(1);
    const anchor = (global as any).__avAnchorCalls[0];
    expect(anchor.event_type).toBe('SERVICE_FULFILLED');
    expect(anchor.hal_score).toBe(0.71);
    expect(anchor.hal_decision).toBe('flagged');
    expect(anchor.contract_id).toBe('c-1');
  });

  test('4. hal_signals roundtrips into metadata.hal_signals', async () => {
    const signals = { harm_probability: 0.12, epistemic_uncertainty: 0.3, agreement_score: 0.95 };
    await applyValidationEvent(AGENT_ID, 'SERVICE_FULFILLED', 10, { role: 'provider' }, {
      hal_score: 0.2,
      hal_decision: 'clean',
      hal_signals: signals,
    });
    const row = (global as any).__avInsertCalls[0];
    expect(row.metadata.hal_signals).toEqual(signals);
    expect(row.metadata.role).toBe('provider');
  });

  test('5. non-SERVICE_FULFILLED event does NOT anchor (gate preserved)', async () => {
    await applyValidationEvent(AGENT_ID, 'VALIDATION_PASSED', 10, {}, { hal_score: 0.1, hal_decision: 'clean' });
    expect((global as any).__avAnchorCalls.length).toBe(0);
  });
});
