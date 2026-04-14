import { computeDecayFactor, applyDecay } from '../decay';

describe('computeDecayFactor', () => {
  test('APEX inactive decays fastest (~0.95)', () => {
    expect(computeDecayFactor({currentRepId:10000,activity30d:0})).toBeCloseTo(0.95,2);
  });
  test('APEX active barely decays', () => {
    expect(computeDecayFactor({currentRepId:10000,activity30d:30})).toBeGreaterThan(0.995);
  });
  test('Mid-tier inactive moderate decay', () => {
    const f = computeDecayFactor({currentRepId:1000,activity30d:0});
    expect(f).toBeGreaterThan(0.98); expect(f).toBeLessThan(0.99);
  });
  test('Low-RepID decays slowly', () => {
    expect(computeDecayFactor({currentRepId:100,activity30d:0})).toBeGreaterThan(0.99);
  });
  test('Floor enforced at 0.90', () => {
    expect(computeDecayFactor({currentRepId:10000,activity30d:0}))
      .toBeGreaterThanOrEqual(0.90);
  });
});

describe('applyDecay', () => {
  test('Floor at 10', () => { expect(applyDecay(10,0)).toBe(10); });
  test('APEX decays to 9500', () => { expect(applyDecay(10000,0)).toBe(9500); });
  test('Returns integer', () => {
    expect(Number.isInteger(applyDecay(4150,5))).toBe(true);
  });
});
