import { fractionForRepID, REPID_TIERS } from '../src/repid-staking/repid-fraction';

describe('fractionForRepID', () => {
  it('handles exact boundaries properly', () => {
    expect(fractionForRepID(0)).toBe(0.00);
    expect(fractionForRepID(1)).toBe(0.01);
    expect(fractionForRepID(99)).toBe(0.01);
    expect(fractionForRepID(100)).toBe(0.05);
    expect(fractionForRepID(999)).toBe(0.05);
    expect(fractionForRepID(1000)).toBe(0.10);
    expect(fractionForRepID(2999)).toBe(0.10);
    expect(fractionForRepID(3000)).toBe(0.20);
    expect(fractionForRepID(4999)).toBe(0.20);
    expect(fractionForRepID(5000)).toBe(0.35);
    expect(fractionForRepID(6999)).toBe(0.35);
    expect(fractionForRepID(7000)).toBe(0.50);
    expect(fractionForRepID(8499)).toBe(0.50);
    expect(fractionForRepID(8500)).toBe(0.70);
    expect(fractionForRepID(9499)).toBe(0.70);
    expect(fractionForRepID(9500)).toBe(0.85);
    expect(fractionForRepID(9999)).toBe(0.85);
    expect(fractionForRepID(10000)).toBe(1.00);
    expect(fractionForRepID(10001)).toBe(1.00);
    expect(fractionForRepID(99999)).toBe(1.00);
  });

  it('throws on negative values', () => {
    expect(() => fractionForRepID(-1)).toThrow('RepID cannot be negative');
    expect(() => fractionForRepID(-100)).toThrow('RepID cannot be negative');
  });

  it('rounds down non-integers', () => {
    expect(fractionForRepID(0.99)).toBe(0.00);
    expect(fractionForRepID(99.9)).toBe(0.01);
    expect(fractionForRepID(100.1)).toBe(0.05);
    expect(fractionForRepID(9999.9)).toBe(0.85);
  });

  it('throws on invalid inputs', () => {
    expect(() => fractionForRepID(NaN)).toThrow('RepID must be a number');
    expect(() => fractionForRepID('100' as any)).toThrow('RepID must be a number');
  });
});
