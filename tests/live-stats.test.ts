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
      // full_harness_loops — added 2026-08-01. It sits between settlements and
      // stubs in the Promise.all, so omitting it here silently shifted every
      // later mock by one and stub_proofs_excluded came back undefined. The
      // mock order IS the contract; keep it aligned with live-stats.ts.
      .mockResolvedValueOnce([{ n: 3 }])
      .mockResolvedValueOnce([{ n: 56823 }]);
  });

  it('returns real numbers shape with stub exclusion note', async () => {
    const s = await fetchLiveStats();
    expect(s.agents_minted).toBe(12);
    expect(s.real_proofs).toBe(21960);
    expect(s.credentials_issued).toBe(6);
    expect(s.total_repid).toBe(8500);
    expect(s.recent_settlements).toBe(8);
    expect(s.full_harness_loops).toBe(3);
    expect(s.notes?.stub_proofs_excluded).toBe(56823);
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes('is_real = true'))).toBe(true);
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes('trinity-agent-mock'))).toBe(true);
    // Public counters must never include simulated settlements — a settlement
    // where no money moved cannot be allowed to inflate a public number.
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes('is_simulated = false'))).toBe(true);
    // full_harness_loops requires BOTH a settled contract and real money.
    expect(pgQueryMock.mock.calls.some((c) => String(c[0]).includes("c.status = 'settled'"))).toBe(true);
  });
});