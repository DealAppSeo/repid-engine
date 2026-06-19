const pgQueryMock = jest.fn();

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...args),
}));

import { emitPeerVerifyScoreEvents } from '../src/services/peer-verify-score';

describe('emitPeerVerifyScoreEvents', () => {
  beforeEach(() => {
    pgQueryMock.mockReset();
    delete process.env.PEER_VERIFY_REPID_ENABLED;
  });

  it('inserts producer + verifier events on verified verdict via pgQuery', async () => {
    pgQueryMock
      .mockResolvedValueOnce([{ id: 101, repid_after: 53, repid_delta_applied: 3 }])
      .mockResolvedValueOnce([{ id: 102, repid_after: 47, repid_delta_applied: 3 }]);

    const result = await emitPeerVerifyScoreEvents({
      queueId: 42,
      producerAgentId: '11111111-2222-4333-8444-555555555555',
      verifierAgentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      verdict: 'verified',
      claimText: 'test claim',
      certaintyAtClaim: 0.8,
    });

    expect(result.emitted).toBe(true);
    expect(result.producerRepidAfter).toBe(53);
    expect(result.verifierRepidAfter).toBe(47);
    expect(pgQueryMock).toHaveBeenCalledTimes(2);
    const firstSql = pgQueryMock.mock.calls[0]![0] as string;
    expect(firstSql).toMatch(/INSERT INTO repid_score_events/);
    const producerParams = pgQueryMock.mock.calls[0]![1] as any[];
    expect(producerParams[1]).toBe('PEER_VERIFY_VERIFIED');
    expect(producerParams[2]).toBe(3);
    expect(producerParams[3]).toBe('peer_verify:42:producer');
  });

  it('no-ops when PEER_VERIFY_REPID_ENABLED=false', async () => {
    process.env.PEER_VERIFY_REPID_ENABLED = 'false';
    const result = await emitPeerVerifyScoreEvents({
      queueId: 1,
      producerAgentId: '11111111-2222-4333-8444-555555555555',
      verifierAgentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      verdict: 'verified',
    });
    expect(result.emitted).toBe(false);
    expect(pgQueryMock).not.toHaveBeenCalled();
  });
});