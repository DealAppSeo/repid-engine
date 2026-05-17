// Phase 2.10 — ServiceHandlerBase: process() shim, processOne lifecycle,
// SERVICE_FULFILLED deltas. db + delta layer mocked (no network/LLM).

const maybeSingleQueue: any[] = [];
const terminalResult = { error: null as any };

jest.mock('../../src/db', () => {
  // Chainable, thenable mock: every builder method returns the same object;
  // awaiting it resolves to terminalResult; maybeSingle() shifts a queued result.
  const chain: any = {};
  for (const m of ['from', 'select', 'eq', 'order', 'limit', 'update']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.maybeSingle = jest.fn(async () =>
    maybeSingleQueue.length ? maybeSingleQueue.shift() : { data: null, error: null }
  );
  chain.then = (resolve: any) => resolve(terminalResult);
  return { db: chain };
});

jest.mock('../../src/services/validation-repid-delta', () => ({
  applyServiceFulfilledDeltas: jest.fn().mockResolvedValue(undefined),
}));

import { ServiceHandlerBase } from '../../src/services/service-handler-base';
import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';

class TestHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'verification';
  public fulfilled = false;
  protected async fulfill(): Promise<Record<string, unknown>> {
    this.fulfilled = true;
    return { ok: true };
  }
}

const contract = {
  id: 'c1', service_id: 's1', provider_agent_id: 'p1',
  buyer_agent_id: 'b1', status: 'escrowed', payload: {}, metadata: {},
};

describe('ServiceHandlerBase (Phase 2.10 production superset)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    maybeSingleQueue.length = 0;
    terminalResult.error = null;
  });

  it('retains Phase 2.11 surface: process() delegates to fulfill()', async () => {
    const h = new TestHandler();
    await h.process({ id: 'x', provider_agent_id: 'p', buyer_agent_id: 'b', payload: {}, status: 'escrowed' });
    expect(h.fulfilled).toBe(true);
  });

  it('processOne → {processed:false} when no escrowed contract', async () => {
    maybeSingleQueue.push({ data: null, error: null }); // fetch: none
    const r = await new TestHandler().processOne('p1');
    expect(r.processed).toBe(false);
  });

  it('processOne claims, fulfils, applies SERVICE_FULFILLED deltas', async () => {
    maybeSingleQueue.push({ data: contract, error: null }); // fetch candidate
    maybeSingleQueue.push({ data: contract, error: null }); // claim wins
    const h = new TestHandler();
    const r = await h.processOne('p1');
    expect(r).toEqual({ processed: true, contract_id: 'c1' });
    expect(h.fulfilled).toBe(true);
    expect(applyServiceFulfilledDeltas).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', service_id: 's1', provider_agent_id: 'p1', buyer_agent_id: 'b1' })
    );
  });

  it('processOne is retry-safe: lost claim race → no fulfil', async () => {
    maybeSingleQueue.push({ data: contract, error: null }); // fetch candidate
    maybeSingleQueue.push({ data: null, error: null });      // claim lost
    const h = new TestHandler();
    const r = await h.processOne('p1');
    expect(r.processed).toBe(false);
    expect(h.fulfilled).toBe(false);
  });
});
