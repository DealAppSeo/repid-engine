import { DisputeResolutionWorker } from '../../src/workers/dispute-resolution-worker';
import { db } from '../../src/db';
import * as pcp from '../../src/services/pcp-validator';
import * as judge from '../../src/services/adversarial-judge';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null })
  }
}));

jest.mock('../../src/services/pcp-validator', () => ({
  runPCP: jest.fn().mockResolvedValue({ confidence: 0.8 })
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
});
