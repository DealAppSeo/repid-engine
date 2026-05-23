/**
 * RepID Inflation Patch C — detector unit tests. Mocks pgQuery so the Z-score classification,
 * divide-by-zero guard, threshold handling, and idempotent-insert behavior are tested without a DB.
 * (Real-population Z-scores + DB-level idempotency are verified live in the sprint report §1.)
 */
jest.mock('../../../src/db/direct-pg', () => ({ pgQuery: jest.fn() }));

import { pgQuery } from '../../../src/db/direct-pg';
import {
  detectInflationOutliers,
  recordAlerts,
  type InflationDetection,
} from '../../../src/services/repid-inflation-detector';

const mockPg = pgQuery as jest.Mock;

beforeEach(() => mockPg.mockReset());

describe('RepID Inflation Detector (Patch C)', () => {
  test('flags agents above Z-threshold as outliers, not those below', async () => {
    mockPg.mockResolvedValueOnce([
      { agent_id: 'a-out', repid_delta: '100', pop_mean: '5', pop_stddev: '10', pop_n: '10' }, // z=9.5
      { agent_id: 'a-norm', repid_delta: '4', pop_mean: '5', pop_stddev: '10', pop_n: '10' }, // z=-0.1
    ]);
    const res = await detectInflationOutliers('weekly', 3);
    expect(res.find((r) => r.agent_id === 'a-out')!.is_outlier).toBe(true);
    expect(res.find((r) => r.agent_id === 'a-norm')!.is_outlier).toBe(false);
    expect(res.find((r) => r.agent_id === 'a-out')!.z_score).toBeCloseTo(9.5, 5);
  });

  test('does NOT flag (or NaN) in a zero-variance population (stddev=0)', async () => {
    mockPg.mockResolvedValueOnce([
      { agent_id: 'a1', repid_delta: '5', pop_mean: '5', pop_stddev: '0', pop_n: '3' },
      { agent_id: 'a2', repid_delta: '5', pop_mean: '5', pop_stddev: '0', pop_n: '3' },
    ]);
    const res = await detectInflationOutliers('daily');
    expect(res.every((r) => r.is_outlier === false)).toBe(true);
    expect(res.every((r) => Number.isFinite(r.z_score))).toBe(true);
  });

  test('respects custom Z-threshold (more flags at lower threshold)', async () => {
    const row = [{ agent_id: 'a', repid_delta: '40', pop_mean: '10', pop_stddev: '10', pop_n: '5' }]; // z=3.0
    mockPg.mockResolvedValueOnce(row);
    const strict = await detectInflationOutliers('weekly', 4); // 3.0 > 4 ? no
    mockPg.mockResolvedValueOnce(row);
    const loose = await detectInflationOutliers('weekly', 2); // 3.0 > 2 ? yes
    expect(strict[0]!.is_outlier).toBe(false);
    expect(loose[0]!.is_outlier).toBe(true);
  });

  test('recordAlerts inserts only outliers, idempotently (ON CONFLICT DO NOTHING)', async () => {
    const dets: InflationDetection[] = [
      { agent_id: 'out1', repid_delta: 100, population_mean: 5, population_stddev: 10, population_n: 10, z_score: 9.5, threshold: 3, is_outlier: true },
      { agent_id: 'norm1', repid_delta: 4, population_mean: 5, population_stddev: 10, population_n: 10, z_score: -0.1, threshold: 3, is_outlier: false },
    ];
    mockPg.mockResolvedValue([]);
    const n = await recordAlerts(dets, 'weekly');
    expect(n).toBe(1);
    expect(mockPg).toHaveBeenCalledTimes(1); // only the outlier
    const sql = mockPg.mock.calls[0]![0] as string;
    expect(sql).toMatch(/repid_inflation_alerts/);
    expect(sql).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });
});
