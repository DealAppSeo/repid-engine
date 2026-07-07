/**
 * Anti-Sybil MVP (2026-07-07) — T2 hole B close.
 * The SERVICE_SATISFIED (+30×score) delta must NOT grant economic RepID on a
 * simulated / self-dealt contract when ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT
 * is ON. Flag OFF preserves today's behavior exactly.
 */
import { applyServiceSatisfiedDeltas } from '../../src/services/validation-repid-delta';

// Configurable per-test contract row returned by the mocked db for the sim gate.
let mockContractRow: any = null;
let mockSettlementRow: any = null;

jest.mock('../../src/db', () => {
  const builder: any = {};
  const make = () => {
    let table = '';
    const b: any = {
      from: (t: string) => { table = t; return b; },
      select: () => b,
      eq: () => b,
      maybeSingle: () => {
        if (table === 'service_contracts') return Promise.resolve({ data: mockContractRow, error: null });
        if (table === 'x402_settlements') return Promise.resolve({ data: mockSettlementRow, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      insert: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  };
  return { db: make() };
});

const applyValidationEvent = jest.fn().mockResolvedValue({});
jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: (...args: any[]) => applyValidationEvent(...args),
}));

const CONTRACT = { id: 'c-1', provider_agent_id: 'p-1', buyer_agent_id: 'b-1' };

function deltasApplied(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of applyValidationEvent.mock.calls) {
    const [agentId, eventType, delta] = call;
    if (eventType === 'SERVICE_SATISFIED') out[agentId] = delta;
  }
  return out;
}

describe('SERVICE_SATISFIED settlement gate (T2 hole B)', () => {
  const OLD = process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT;
  beforeEach(() => {
    applyValidationEvent.mockClear();
    mockContractRow = null;
    mockSettlementRow = null;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT;
    else process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT = OLD;
  });

  it('flag OFF (default): +30×score applies even for a simulated contract (today’s behavior)', async () => {
    delete process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT;
    mockContractRow = { metadata: { is_simulated: true }, payload: {}, x402_payment_id: null };
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    const d = deltasApplied();
    expect(d['p-1']).toBe(30); // provider 30 × 1.0
    expect(d['b-1']).toBe(15); // buyer flat 15
  });

  it('flag ON + simulated (metadata flag): BOTH satisfied deltas zeroed', async () => {
    process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT = 'true';
    mockContractRow = { metadata: { is_simulated: true }, payload: {}, x402_payment_id: null };
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    const d = deltasApplied();
    expect(d['p-1']).toBe(0);
    expect(d['b-1']).toBe(0);
  });

  it('flag ON + simulated (linked settlement is_simulated=true): zeroed', async () => {
    process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT = 'true';
    mockContractRow = { metadata: {}, payload: {}, x402_payment_id: 'x-1' };
    mockSettlementRow = { is_simulated: true };
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    const d = deltasApplied();
    expect(d['p-1']).toBe(0);
    expect(d['b-1']).toBe(0);
  });

  it('flag ON + REAL settlement (settlement is_simulated=false, no sim flags): deltas apply', async () => {
    process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT = 'true';
    mockContractRow = { metadata: {}, payload: {}, x402_payment_id: 'x-1' };
    mockSettlementRow = { is_simulated: false };
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    const d = deltasApplied();
    expect(d['p-1']).toBe(30);
    expect(d['b-1']).toBe(15);
  });

  it('flag ON + contract missing: fail-closed (no economic RepID minted)', async () => {
    process.env.ECONOMIC_DELTA_REQUIRES_REAL_SETTLEMENT = 'true';
    mockContractRow = null;
    await applyServiceSatisfiedDeltas(CONTRACT, 1.0);
    const d = deltasApplied();
    expect(d['p-1']).toBe(0);
    expect(d['b-1']).toBe(0);
  });
});
