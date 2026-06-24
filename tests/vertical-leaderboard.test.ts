const pgQueryMock = jest.fn();

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...args),
}));

import { fetchVerticalLeaderboard } from '../src/services/vertical-leaderboard';

describe('fetchVerticalLeaderboard', () => {
  beforeEach(() => pgQueryMock.mockReset());

  it('uses view when available', async () => {
    pgQueryMock
      .mockResolvedValueOnce([
        { vertical: 'overall', agent_name: 'trinity-mel', current_repid: 500, tier: 'EARNING', domain_pct: null, rank: 1 },
      ])
      .mockResolvedValueOnce([{ vertical: 'trusttrader', n: 6 }]);

    const lb = await fetchVerticalLeaderboard();
    expect(lb.overall[0]!.agent_name).toBe('trinity-mel');
    expect(lb.credential_verticals[0]!.vertical).toBe('trusttrader');
  });
});