/** Defensibility scoring (P0 peer-assessed lens) — pure logic. */
import { scoreDefensibility } from '../src/services/reliability';

describe('scoreDefensibility', () => {
  test('verified / (verified + disputed), rounded 4dp', () => {
    const r = scoreDefensibility({ verified: 287, disputed: 1356, timeout: 4131, in_review: 0 }, 20);
    expect(r.defensibility).toBeCloseTo(0.1747, 4);
    expect(r.conclusive).toBe(1643);
    expect(r.inconclusive).toBe(4131);
    expect(r.sample_ok).toBe(true);
  });

  test('excludes timeout + in_review from the ratio (inconclusive)', () => {
    const r = scoreDefensibility({ verified: 10, disputed: 10, timeout: 999, in_review: 999 }, 20);
    expect(r.defensibility).toBe(0.5); // 10/20, not affected by the 1998 inconclusive
    expect(r.conclusive).toBe(20);
  });

  test('below min sample → null, never a flattering default', () => {
    const r = scoreDefensibility({ verified: 5, disputed: 2, timeout: 100 }, 20);
    expect(r.defensibility).toBeNull();
    expect(r.sample_ok).toBe(false);
    expect(r.conclusive).toBe(7);
  });

  test('zero data → null, no divide-by-zero', () => {
    const r = scoreDefensibility({}, 20);
    expect(r.defensibility).toBeNull();
    expect(r.conclusive).toBe(0);
  });

  test('always provisional and discernment null in P0', () => {
    const r = scoreDefensibility({ verified: 100, disputed: 100 }, 20);
    expect(r.provisional).toBe(true);
    expect(r.discernment).toBeNull();
  });
});
