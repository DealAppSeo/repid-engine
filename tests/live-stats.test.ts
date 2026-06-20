const pgQueryMock = jest.fn();

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...args),
}));

import { fetchLiveStats } from '../src/services/live-stats';

describe('fetchLiveStats', () => {
  beforeEach(() => {
    pgQueryMock.mockReset();
    pgQueryMock
      .mockResolvedValueOnce([{ n: 12 }])
      .mockResolvedValueOnce([{ n: 21960 }])
      .mockResolvedValueOnce([{ n: 6 }])
      .mockResolvedValueOnce([{ total: 8500 }])
      .mockResolvedValueOnce([{ n: 8 }])
      .mockResolvedValueOnce([{ n: 56823 }]);
  });

  it('returns real numbers shape with stub exclusion note', async () => {
    const s = await fetchLiveStats();
    expect(s.agents_minted).toBe(12);
    expect(s.real_proofs).toBe(21960);
    expect(s.credentials_issued).toBe(6);
    expect(s.total_repid).toBe(8500);
    expect(s.recent_settlements).toBe(8);
    expect(s.notes?.stub_proofs_excluded).toBe(56823);
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes('is_real = true'))).toBe(true);
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes('trinity-agent-mock'))).toBe(true);
  });
});