// Phase 2.10 — AnfisRoutingServiceHandler (P-002). db.rpc mocked.
const rpc = jest.fn();
jest.mock('../../src/db', () => ({ db: { rpc: (...a: any[]) => rpc(...a) } }));
jest.mock('../../src/services/validation-repid-delta', () => ({ applyServiceFulfilledDeltas: jest.fn() }));

import { AnfisRoutingServiceHandler } from '../../src/services/anfis-routing-service-handler';

const contract: any = {
  id: 'c1', provider_agent_id: 'p1', buyer_agent_id: 'b1', status: 'escrowed',
  payload: { query: 'q', task_characteristics: { domain: 'code', latency_budget_ms: 4000, cost_budget_usdc_raw: 50000 } },
};

describe('AnfisRoutingServiceHandler (P-002)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('empty RPC result → safe default routing, P-002', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const out = await (new AnfisRoutingServiceHandler() as any).fulfill(contract);
    expect(out.recommended_provider).toBe('groq');
    expect(out.confidence).toBe(0.3);
    expect(out.fallback_chain).toEqual(['anthropic', 'openai']);
    expect((out.historical_basis as any).sample_size).toBe(0);
    expect(out.patent_marker).toBe('P-002');
  });

  it('RPC error → guarded empty → default routing (loud, not thrown)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const out = await (new AnfisRoutingServiceHandler() as any).fulfill(contract);
    expect(out.recommended_provider).toBe('groq');
    expect(out.patent_marker).toBe('P-002');
  });

  it('scores providers and recommends best fitness', async () => {
    rpc.mockResolvedValue({
      data: [
        { provider: 'groq', hit_rate: 0.9, avg_latency_ms: 800, avg_cost_usdc: 0.001, sample_count: 50 },
        { provider: 'openai', hit_rate: 0.7, avg_latency_ms: 3000, avg_cost_usdc: 0.02, sample_count: 30 },
      ],
      error: null,
    });
    const out = await (new AnfisRoutingServiceHandler() as any).fulfill(contract);
    expect(out.recommended_provider).toBe('groq');
    expect(out.fallback_chain).toEqual(['openai']);
    expect((out.historical_basis as any).sample_size).toBe(80);
    expect(out.patent_marker).toBe('P-002');
  });
});
