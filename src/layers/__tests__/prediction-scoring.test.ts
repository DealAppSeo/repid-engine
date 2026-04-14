import { scorePrediction, PHI_CUBED } from '../prediction-scoring';

describe('scorePrediction', () => {
  test('Correct high confidence → large positive', () => {
    expect(scorePrediction({pStated:0.9,pCorrect:1,daysAgo:0,networkImportance:1.0}))
      .toBeGreaterThan(1);
  });
  test('Wrong high confidence → large negative', () => {
    expect(scorePrediction({pStated:0.9,pCorrect:0,daysAgo:0,networkImportance:1.0}))
      .toBeLessThan(-5);
  });
  test('Correct 50% → small positive', () => {
    const r = scorePrediction({pStated:0.5,pCorrect:1,daysAgo:0,networkImportance:1.0});
    expect(r).toBeGreaterThan(0); expect(r).toBeLessThan(20);
  });
  test('Wrong low confidence → tiny negative', () => {
    const r = scorePrediction({pStated:0.1,pCorrect:0,daysAgo:0,networkImportance:1.0});
    expect(r).toBeLessThan(0); expect(r).toBeGreaterThan(-5);
  });
  test('φ³ floor cap prevents infinite penalty', () => {
    expect(scorePrediction({pStated:0.99,pCorrect:0,daysAgo:0,networkImportance:3.0}))
      .toBeGreaterThan(-PHI_CUBED * 15 * 3 - 1);
  });
  test('Time decay: old predictions count less', () => {
    const recent = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:0,networkImportance:1.0});
    const old = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:180,networkImportance:1.0});
    expect(Math.abs(recent)).toBeGreaterThan(Math.abs(old));
  });
  test('Higher importance amplifies score', () => {
    const n = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:1.0});
    const h = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:3.0});
    expect(Math.abs(h)).toBeGreaterThan(Math.abs(n));
  });
  test('Negative daysAgo throws', () => {
    expect(() => scorePrediction({pStated:0.8,pCorrect:1,daysAgo:-1,networkImportance:1.0}))
      .toThrow('daysAgo cannot be negative');
  });
});
