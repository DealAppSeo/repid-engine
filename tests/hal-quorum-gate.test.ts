/**
 * S-R4 — penalty requires a real cross-LLM QUORUM (>= 2 fact-check providers), else fail-safe.
 *
 * A strictness-2 veto only drains RepID when halService produced mode 'fact-check' with
 * providers_used >= 2. When the quorum can't assemble (mode 'extractor-fallback' / providers_used < 2)
 * the penalty is suppressed and logged 'quorum_unavailable' — NEVER a single-provider/extractor drain.
 * This is the live over-flag fix (2026-06-03: 35 deepinfra extractor-fallback drains/15m). Reversible
 * via HAL_PENALTY_REQUIRES_QUORUM. Mocks src/db and src/hal/service so no network/Supabase is hit.
 */
(global as any)._api_key_versions_table_checked = true;
(global as any).__pipAgentRow = null;
(global as any).__pipInsertCalls = [];
(global as any).__pipUpdateCalls = [];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: (global as any).__pipAgentRow ?? null, error: (global as any).__pipAgentRow ? null : { message: 'nf' } }) }) }),
          update: (p: any) => ({ eq: () => { (global as any).__pipUpdateCalls.push(p); return Promise.resolve({ data: null, error: null }); } }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          select: (_c?: string, o?: any) => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }) }) }),
          insert: (p: any) => ({ select: () => ({ single: async () => { (global as any).__pipInsertCalls.push(p); return { data: { id: 999 }, error: null }; } }) }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/hal/service', () => ({ halService: { evaluate: jest.fn() } }));

import { runScoreEvent } from '../src/scoring/pipeline';
import { halService } from '../src/hal/service';

const AGENT = '11111111-2222-4333-8444-555555555555';
const evalMock = halService.evaluate as jest.Mock;
const setAgent = () => { (global as any).__pipAgentRow = { id: AGENT, current_repid: 1000, tier: 'ESTABLISHED', vesting_cliff_ends_at: null }; };

beforeEach(() => {
  (global as any).__pipAgentRow = null;
  (global as any).__pipInsertCalls = [];
  (global as any).__pipUpdateCalls = [];
  evalMock.mockReset();
  process.env.HAL_STRICTNESS = '2';
  delete process.env.HAL_PENALTY_REQUIRES_QUORUM;
  delete process.env.HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION;
});
afterAll(() => { delete process.env.HAL_STRICTNESS; });

const run = () => runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: 'some answer', provider_used: 'deepinfra' });

describe('S-R4 quorum-gated penalty', () => {
  test('extractor-fallback veto (no quorum) → NO drain, quorum_unavailable', async () => {
    setAgent();
    evalMock.mockResolvedValue({ hal_score: 0.265, decision: 'vetoed', mode: 'extractor-fallback', strictness: 2, signals: {} });
    const r = await run();
    expect(r.hal_decision).toBe('vetoed');
    expect(r.repid_delta_calculated).toBe(-10); // earned penalty recorded
    expect(r.repid_delta_applied).toBe(0);       // ...but NOT applied
    expect(r.new_repid).toBe(1000);
    const ins = (global as any).__pipInsertCalls[0];
    expect(ins.hallucination_caught).toBe(false);
    expect(ins.delta).toBe(0);
    expect(ins.metadata.quorum_met).toBe(false);
    expect(ins.metadata.suppressed_reason).toBe('quorum_unavailable');
    expect((global as any).__pipUpdateCalls[0].current_repid).toBe(1000);
  });

  test('single-provider veto (providers_used=1) → NO drain', async () => {
    setAgent();
    evalMock.mockResolvedValue({ hal_score: 0.9, decision: 'vetoed', mode: 'fact-check', strictness: 2, signals: { providers_used: 1, provider_health: { succeeded: 1 } } });
    const r = await run();
    expect(r.repid_delta_applied).toBe(0);
    expect((global as any).__pipInsertCalls[0].metadata.suppressed_reason).toBe('quorum_unavailable');
  });

  test('real >=2-provider quorum veto → penalty APPLIES, evidence shows quorum', async () => {
    setAgent();
    evalMock.mockResolvedValue({ hal_score: 0.9, decision: 'vetoed', mode: 'fact-check', strictness: 2, signals: { providers_used: 2, provider_health: { attempted: 3, succeeded: 2 } } });
    const r = await run();
    expect(r.repid_delta_applied).toBe(-10);
    expect(r.new_repid).toBe(990);
    const ins = (global as any).__pipInsertCalls[0];
    expect(ins.hallucination_caught).toBe(true);
    expect(ins.delta).toBe(-10);
    expect(ins.metadata.quorum_met).toBe(true);
    expect(ins.metadata.quorum_providers_used).toBe(2);
  });

  test('flag OFF (HAL_PENALTY_REQUIRES_QUORUM=false) → legacy single-provider drain (regression control)', async () => {
    process.env.HAL_PENALTY_REQUIRES_QUORUM = 'false';
    setAgent();
    evalMock.mockResolvedValue({ hal_score: 0.265, decision: 'vetoed', mode: 'extractor-fallback', strictness: 2, signals: {} });
    const r = await run();
    expect(r.repid_delta_applied).toBe(-10); // without the gate, the extractor-fallback veto drains
    expect((global as any).__pipInsertCalls[0].hallucination_caught).toBe(true);
  });
});
