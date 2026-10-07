import { DisputeResolutionWorker } from '../../src/workers/dispute-resolution-worker';
import { db } from '../../src/db';
import * as pcp from '../../src/services/pcp-validator';
import * as judge from '../../src/services/adversarial-judge';

jest.mock('../../src/db', () => {
  const chain: any = {
    from: jest.fn().mockImplementation(() => chain),
    select: jest.fn().mockImplementation(() => chain),
    eq: jest.fn().mockImplementation(() => chain),
    order: jest.fn().mockImplementation(() => chain),
    limit: jest.fn().mockImplementation(() => chain),
    update: jest.fn().mockImplementation(() => chain),
    insert: jest.fn().mockImplementation(() => chain),
    upsert: jest.fn().mockImplementation(() => chain),
    single: jest.fn().mockImplementation(() => Promise.resolve({ data: { id: 'test-agent', current_repid: 1000 }, error: null })),
    maybeSingle: jest.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    rpc: jest.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    then: jest.fn().mockImplementation((onfulfilled) => Promise.resolve({ data: null, error: null }).then(onfulfilled))
  };

  return {
    db: chain
  };
});

jest.mock('../../src/services/pcp-validator', () => ({
  runPCP: jest.fn().mockResolvedValue({ confidence: 0.8, checked: true })
}));

jest.mock('../../src/services/adversarial-judge', () => ({
  runAdversarialJudge: jest.fn().mockResolvedValue({ verdict: 'APPROVE', confidence: 0.9 })
}));

describe('DisputeResolutionWorker', () => {
  let worker: DisputeResolutionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new DisputeResolutionWorker();
  });

  it('processes a pending dispute and issues buyer_at_fault', async () => {
    (db.maybeSingle as jest.Mock)
      .mockResolvedValueOnce({
        data: {
          id: 'dispute-1',
          service_contracts: {
            id: 'contract-1',
            provider_agent_id: 'prov-1',
            buyer_agent_id: 'buy-1',
            result: { data: 'test' }
          }
        }
      })
      .mockResolvedValueOnce({
        data: { id: 'dispute-1' } // atomic claim success
      });

    const handled = await (worker as any).processOne();
    expect(handled).toBe(true);
    expect(pcp.runPCP).toHaveBeenCalled();
    expect(judge.runAdversarialJudge).toHaveBeenCalled();
  });

  // [F2] No validator answered: confidence 0 used to read as "< 0.3" -> provider_at_fault, a -100
  // for work nobody assessed. Not checked is no verdict: back to pending, nothing resolved.
  it('no validator answered: NOT CHECKED — left pending, no verdict, no judge, no deltas', async () => {
    (pcp.runPCP as jest.Mock).mockResolvedValueOnce({ confidence: 0, checked: false });
    (db.maybeSingle as jest.Mock)
      .mockResolvedValueOnce({
        data: {
          id: 'dispute-2',
          metadata: { not_checked_count: 1 },
          service_contracts: { id: 'contract-2', provider_agent_id: 'prov-1', buyer_agent_id: 'buy-1', result: { data: 'x' } },
        },
      })
      .mockResolvedValueOnce({ data: { id: 'dispute-2' } });

    const handled = await (worker as any).processOne();
    expect(handled).toBe(false);
    expect(judge.runAdversarialJudge).not.toHaveBeenCalled();
    const updates = (db.update as jest.Mock).mock.calls.map((c) => c[0]);
    // the claim, then the release — never a 'completed' row, never a contract verdict
    expect(updates).toContainEqual(expect.objectContaining({ status: 'pending', metadata: expect.objectContaining({ not_checked_count: 2 }) }));
    expect(updates.some((u) => u.status === 'completed' || u.status === 'resolved' || 'dispute_verdict' in u)).toBe(false);
  });
});
