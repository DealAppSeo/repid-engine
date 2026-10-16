// Phase 2.10 — ServiceHandlerBase: process() shim, processOne lifecycle,
// SERVICE_FULFILLED deltas. db + delta layer mocked (no network/LLM).

const maybeSingleQueue: any[] = [];
const terminalResult = { error: null as any };

jest.mock('../../src/db', () => {
  // Chainable, thenable mock: every builder method returns the same object;
  // awaiting it resolves to terminalResult; maybeSingle() shifts a queued result.
  const chain: any = {};
  // `not` is here for claimNextContract's two-pass claim: pass 1 asks for rows
  // that can actually reach `fulfilled` (non-NULL work_statement_hash), pass 2
  // falls back to plain FIFO. This double models no filters at all — not even
  // `eq` — so `not` is a passthrough like the rest, and the queue order below
  // still drives every case. The FILTERING behaviour is pinned separately in
  // tests/service-handler-claim-order.test.ts, which does model it.
  for (const m of ['from', 'select', 'eq', 'not', 'order', 'limit', 'update']) {
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

// VALIDATOR_POOL_INTEGRITY ON (XC1 on #1433): an UNDETERMINED filed because too few independent
// validators existed was assessed by nobody, so it earns nobody SERVICE_FULFILLED RepID (+10/+5).
describe('ServiceHandlerBase: no SERVICE_FULFILLED deltas for an unstaffed check', () => {
  class Returns extends ServiceHandlerBase {
    protected readonly serviceType = 'verification';
    constructor(private readonly out: Record<string, unknown>) { super(); }
    protected async fulfill(): Promise<Record<string, unknown>> { return this.out; }
  }
  const run = async (out: Record<string, unknown>) => {
    maybeSingleQueue.push({ data: contract, error: null }, { data: contract, error: null });
    return new Returns(out).processOne('p1');
  };
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    maybeSingleQueue.length = 0;
    terminalResult.error = null;
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('UNDETERMINED + insufficient_independent_validators: filed, no deltas, says why', async () => {
    const r = await run({ verdict: 'UNDETERMINED', validator_pool: 'insufficient_independent_validators' });
    expect(r).toEqual({ processed: true, contract_id: 'c1' });
    expect(applyServiceFulfilledDeltas).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/c1 filed UNDETERMINED: too few independent validators .* deltas NOT applied/));
  });

  it('a chain-decided PASS with the same marker was assessed: deltas as before', async () => {
    await run({ verdict: 'PASS', validator_pool: 'insufficient_independent_validators' });
    expect(applyServiceFulfilledDeltas).toHaveBeenCalledTimes(1);
  });

  it('any other UNDETERMINED (flag OFF never sets the marker): deltas as before', async () => {
    await run({ verdict: 'UNDETERMINED' });
    expect(applyServiceFulfilledDeltas).toHaveBeenCalledTimes(1);
  });
});
