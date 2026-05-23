/**
 * RepID Inflation — combined C + B defense matrix.
 *
 * C (Z-score detector) catches gaming BEHAVIOR (abnormal growth, any mechanism).
 * B (counterparty gate) catches STRUCTURAL concentration (advancement on too few counterparties).
 * Together they cover both axes. This test drives C with three attack shapes (mocked pgQuery) and
 * asserts the expected B outcome via a gate oracle that mirrors compute_tier(integer,uuid) at the
 * strict target thresholds (the real SQL gate is verified separately in counterparty-gate.test.ts
 * and live in report §2). The point here is the COVERAGE MATRIX, not re-testing each layer's internals.
 */
jest.mock('../../../src/db/direct-pg', () => ({ pgQuery: jest.fn() }));

import { pgQuery } from '../../../src/db/direct-pg';
import { detectInflationOutliers } from '../../../src/services/repid-inflation-detector';

const mockPg = pgQuery as jest.Mock;
beforeEach(() => mockPg.mockReset());

// Oracle mirroring the gate's cascade (strict thresholds) — test expectation only, not the impl.
function gatedTier(repid: number, cp: number): string {
  let t =
    repid >= 8000 ? 'VETERAN' : repid >= 5000 ? 'AUTONOMOUS' : repid >= 1000 ? 'ESTABLISHED' : repid >= 500 ? 'EARNING' : 'PROBATIONARY';
  const vet = 10, auto = 5, est = 3, earn = 1;
  if (t === 'VETERAN' && cp < vet) t = 'AUTONOMOUS';
  if (t === 'AUTONOMOUS' && cp < auto) t = 'ESTABLISHED';
  if (t === 'ESTABLISHED' && cp < est) t = 'EARNING';
  if (t === 'EARNING' && cp < earn) t = 'PROBATIONARY';
  return t;
}
async function cFlags(delta: number, mean: number, stddev: number): Promise<boolean> {
  mockPg.mockResolvedValueOnce([{ agent_id: 'x', repid_delta: String(delta), pop_mean: String(mean), pop_stddev: String(stddev), pop_n: '10' }]);
  const res = await detectInflationOutliers('weekly', 3);
  return res[0]!.is_outlier;
}

describe('Combined C+B Defense', () => {
  test('1-counterparty rapid-fire: caught by B (tier capped); C also flags the burst', async () => {
    // High repid earned fast through a single buyer.
    expect(gatedTier(6000, 1)).toBe('EARNING'); // B: AUTONOMOUS→ESTABLISHED→EARNING (cp1 < 5, then < 3; not < 1)
    expect(gatedTier(6000, 1)).not.toBe('AUTONOMOUS');
    expect(await cFlags(500, 50, 100)).toBe(true); // C: z=4.5 outlier
  });

  test('slow-burn with many counterparties: B passes, caught by C (z-score)', async () => {
    expect(gatedTier(6000, 8)).toBe('AUTONOMOUS'); // B: 8>=5 → advancement allowed
    expect(await cFlags(350, 50, 90)).toBe(true);   // C: z≈3.33 outlier
  });

  test('legitimate high-performer (many counterparties, in-line growth): passes both', async () => {
    expect(gatedTier(6000, 8)).toBe('AUTONOMOUS'); // B: allowed
    expect(await cFlags(60, 50, 100)).toBe(false);  // C: z=0.1 not flagged
  });
});
