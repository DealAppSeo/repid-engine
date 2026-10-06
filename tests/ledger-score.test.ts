/**
 * Checker ledger scoring (src/ledger/score.ts). The numbers asserted here are the 2026-10-05
 * labelled run (eval/rigorous/baseline-classify-2026-10-05.jsonl), so a change to the scoring rule
 * that moves them shows up as a failing test, not as a quietly different leaderboard.
 */
import { DISPLAY_FLOOR, K_WRONG, comparePaired, contradicted, normalCdf, readSlice, signTest, utility, wilson } from '../src/ledger/score';

describe('k is the operator\'s decision, pinned', () => {
  it('a wrong verdict costs three right ones (Sean, 2026-10-06)', () => {
    expect(K_WRONG).toBe(3);
    expect(DISPLAY_FLOOR).toBe(100);
  });
});

describe('readSlice on the 2026-10-05 run', () => {
  const gpt = { right: 256, wrong: 40, unsure: 31, none: 10 };
  const qwen = { right: 178, wrong: 14, unsure: 136, none: 9 };

  it('the two production checkers tie exactly at k = 3', () => {
    expect(readSlice(gpt).score).toBe(136);
    expect(readSlice(qwen).score).toBe(136);
  });

  it('below 3 the one that guesses more wins, above 3 the careful one does', () => {
    expect(readSlice(gpt, 2).score).toBeGreaterThan(readSlice(qwen, 2).score);
    expect(readSlice(gpt, 4).score).toBeLessThan(readSlice(qwen, 4).score);
  });

  it('precision carries its 95% range, and coverage is kept apart from it', () => {
    const r = readSlice(gpt);
    expect(r.n).toBe(337);
    expect(r.precision).toBeCloseTo(256 / 296, 6);
    expect(r.precisionRange!.lo).toBeCloseTo(0.821, 3);
    expect(r.precisionRange!.hi).toBeCloseTo(0.899, 3);
    expect(r.coverage).toBeCloseTo(296 / 337, 6);
    expect(r.shown).toBe(true);
  });
});

describe('abstaining is never rewarded', () => {
  it('a checker that says UNSURE to everything scores 0, not "never wrong"', () => {
    const r = readSlice({ right: 0, wrong: 0, unsure: 500, none: 0 });
    expect(r.score).toBe(0);
    expect(r.precision).toBeNull();
    expect(r.precisionRange).toBeNull();
  });

  it('unsure and no answer are worth the same: 0', () => {
    expect(utility('UNSURE', 'TRUE')).toBe(0);
    expect(utility('NONE', 'FALSE')).toBe(0);
    expect(utility('TRUE', 'TRUE')).toBe(1);
    expect(utility('TRUE', 'FALSE')).toBe(-3);
  });
});

describe('nothing under the floor is a rate', () => {
  it('99 answers: counts, shown false', () => {
    const r = readSlice({ right: 90, wrong: 5, unsure: 4, none: 0 });
    expect(r.n).toBe(99);
    expect(r.shown).toBe(false);
  });
  it('100 answers: shown', () => {
    expect(readSlice({ right: 90, wrong: 5, unsure: 5, none: 0 }).shown).toBe(true);
  });
});

describe('wilson', () => {
  it('174 of 180 (the decided stamps on 2026-10-05): about 92.9% to 98.5%', () => {
    const r = wilson(174, 180)!;
    expect(r.lo).toBeCloseTo(0.929, 3);
    expect(r.hi).toBeCloseTo(0.985, 3);
  });
  it('no trials is no range, not 0% to 100%', () => {
    expect(wilson(0, 0)).toBeNull();
  });
  it('stays inside [0, 1] at the edges', () => {
    const all = wilson(50, 50)!;
    const none = wilson(0, 50)!;
    expect(all.hi).toBeLessThanOrEqual(1);
    expect(none.lo).toBeGreaterThanOrEqual(0);
  });
});

describe('signTest and comparePaired', () => {
  it('12 to 1 (the S37 flag test) is p about 0.003', () => {
    expect(signTest(12, 1)).toBeCloseTo(0.0034, 4);
  });
  it('23 to 7 is p about 0.005', () => {
    expect(signTest(23, 7)).toBeCloseTo(0.0052, 4);
  });
  it('an even split is not evidence', () => {
    expect(signTest(8, 8)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
  });
  it('stays finite for large n', () => {
    const p = signTest(1100, 900);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThan(0.001);
  });
  it('counts which side did better, item by item', () => {
    const r = comparePaired([
      { truth: 'TRUE', a: 'TRUE', b: 'TRUE' }, // same
      { truth: 'TRUE', a: 'TRUE', b: 'UNSURE' }, // a better by 1
      { truth: 'FALSE', a: 'TRUE', b: 'UNSURE' }, // b better by 3: a wrong costs 3, unsure costs 0
      { truth: 'FALSE', a: 'NONE', b: 'UNSURE' }, // same: both 0
    ]);
    expect(r).toMatchObject({ items: 4, aBetter: 1, bBetter: 1, difference: -2 });
  });

  it('more wins is not better when the other side\'s wins are bigger (the 2026-10-05 trap)', () => {
    // a wins 3 items by 1, b wins 1 item by 3: the totals tie, so there is no difference to find.
    const items = [
      ...Array.from({ length: 30 }, () => ({ truth: 'TRUE' as const, a: 'TRUE' as const, b: 'UNSURE' as const })),
      ...Array.from({ length: 10 }, () => ({ truth: 'FALSE' as const, a: 'TRUE' as const, b: 'UNSURE' as const })),
    ];
    const r = comparePaired(items);
    expect(r.aBetter).toBe(30);
    expect(r.bBetter).toBe(10);
    expect(signTest(r.aBetter, r.bBetter)).toBeLessThan(0.01); // what a sign test would wrongly say
    expect(r.difference).toBe(0);
    expect(r.p).toBeCloseTo(1, 6); // what the paired difference says
  });

  it('a real difference shows up', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      truth: 'TRUE' as const,
      a: 'TRUE' as const,
      b: (i % 2 === 0 ? 'FALSE' : 'TRUE') as 'TRUE' | 'FALSE',
    }));
    expect(comparePaired(items).p).toBeLessThan(0.001);
  });

  it('normalCdf', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe('contradicted', () => {
  it('only a flat TRUE against a flat FALSE', () => {
    expect(contradicted('TRUE', 'FALSE')).toBe(true);
    expect(contradicted('FALSE', 'TRUE')).toBe(true);
    expect(contradicted('TRUE', 'UNSURE')).toBe(false);
    expect(contradicted('NONE', 'FALSE')).toBe(false);
    expect(contradicted('TRUE', 'TRUE')).toBe(false);
  });
});
