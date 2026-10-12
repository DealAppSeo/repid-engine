/**
 * An equation is decided by EXACT calculation, not by a float tolerance.
 *
 * THE FINDING (XC1 red team). `classifyLocal` evaluated both sides as JS doubles and called them equal
 * when they were within 1e-9 RELATIVE. A relative tolerance grows with the numbers, so once an operand
 * passes ~10^9 the allowance is >= 1 and a FALSE equation reads `pass`:
 *
 *     100000000 + 1 = 100000000     veto   (correct: tolerance 0.1)
 *     1000000000 + 1 = 1000000000   pass   (WRONG: tolerance 1.0 swallows the +1)
 *
 * Past 2^53 it is worse: the double cannot tell the two numbers apart at all, however small the
 * tolerance, so a false claim passes by arithmetic that never looked at the digits. Both the CLI and
 * the extension call this route, and the route's contract (and Sean's /check spec) is "an equation is
 * decided by exact calculation". The kernel's parseAmountRaw already refuses doubles for money with
 * BigInt; the public classifier did not.
 *
 * WHAT IS PINNED, in three groups:
 *   1. the false positives, which must now veto (and their TRUE twins, which must still pass — a
 *      "fix" that vetoes every big number would also go green on group 1);
 *   2. decimals and quotients, decided exactly, with the old approximation behaviour kept;
 *   3. what is NOT in the exact grammar still falls back to the old evaluator instead of breaking.
 */
import express from 'express';
import request from 'supertest';
import { classifyLocal, createClassifyRouter } from '../src/routes/classify';
import { safeEvalExact, safeEvalArithmetic } from '../src/hal/safe-arithmetic';

describe('integer equations are decided exactly (the finding)', () => {
  // [text, expected]. Each false claim is paired with its true twin below.
  const VETO: string[] = [
    '100000000 + 1 = 100000000', // below the old hole: always vetoed, kept as the control
    '1000000000 + 1 = 1000000000', // XC1's reproduction
    '12345678901 + 5 = 12345678901',
    '2000000000 * 3 = 6000000001',
    '-1000000000 - 1 = -1000000000',
    '1,000,000,000 + 1 = 1,000,000,000', // thousands separators on both sides
    '9007199254740993 + 0 = 9007199254740992', // beyond 2^53: the two numbers are the same double
    '9007199254740992 + 1 = 9007199254740992',
    '99999999999 * 99999999999 = 9999999999800000000000', // off by one in the 22nd digit
    '2 ^ 62 = 4611686018427387905', // 2^62 + 1: the same double as 2^62
    '(1000000000 + 1) * 2 = 2000000000',
  ];
  const PASS: string[] = [
    '1000000000 + 1 = 1000000001',
    '12345678901 + 5 = 12345678906',
    '2000000000 * 3 = 6000000000',
    '-1000000000 - 1 = -1000000001',
    '1,000,000,000 + 1 = 1,000,000,001',
    '9007199254740993 + 0 = 9007199254740993',
    '9007199254740992 + 1 = 9007199254740993',
    '99999999999 * 99999999999 = 9999999999800000000001',
    '2 ^ 62 = 4611686018427387904',
    '(1000000000 + 1) * 2 = 2000000002',
    '3 * (4 + 1) = 15', // ordinary sizes keep working
  ];

  test.each(VETO)('FALSE  %s -> veto', (text) => {
    expect(classifyLocal(text)).toBe('veto');
  });
  test.each(PASS)('TRUE   %s -> pass', (text) => {
    expect(classifyLocal(text)).toBe('pass');
  });

  test('a one-off at every magnitude from 10^1 to 10^30 is a veto, and its twin a pass', () => {
    // The old behaviour flipped at ~10^9 and never came back; sweep the whole range so a fix that
    // moved the threshold instead of removing it cannot pass.
    for (let digits = 1; digits <= 30; digits++) {
      const n = '1' + '0'.repeat(digits);
      const next = (BigInt(n) + 1n).toString();
      expect(`${n} + 1 = ${n} -> ${classifyLocal(`${n} + 1 = ${n}`)}`).toBe(`${n} + 1 = ${n} -> veto`);
      expect(`${n} + 1 = ${next} -> ${classifyLocal(`${n} + 1 = ${next}`)}`).toBe(`${n} + 1 = ${next} -> pass`);
    }
  });
});

describe('decimals and quotients are decided exactly, approximations keep their old verdict', () => {
  test.each([
    ['0.1 + 0.2 = 0.3', 'pass'], // exact now; the old float needed its epsilon to say this
    ['10 / 4 = 2.5', 'pass'],
    ['1 / 3 * 3 = 1', 'pass'], // exact rational, no float residue
    ['50% * 10 = 5', 'pass'],
    ['2 ^ -1 = 0.5', 'pass'],
    ['1000000000.5 + 0.1 = 1000000000.6', 'pass'],
    ['1000000000.5 + 0.1 = 1000000000.5', 'veto'], // the same hole, with a decimal
    ['1000000000 + 0.5 = 1000000000', 'veto'],
    ['0.1 + 0.2 = 0.30000001', 'veto'],
    // Rounded approximations: unchanged. Coarser than 1e-9 was a veto before and still is.
    ['1 / 3 = 0.333', 'veto'],
    ['22 / 7 = 3.14', 'veto'],
    ['2 / 3 = 0.67', 'veto'],
    // Finer than 1e-9 (a repeating decimal written out) was a pass before and still is.
    ['1 / 3 = 0.3333333333', 'pass'],
    ['2 / 3 = 0.6666666667', 'pass'],
  ])('%s -> %s', (text, expected) => {
    expect(classifyLocal(text)).toBe(expected);
  });
});

describe('what the exact grammar does not cover still falls back, and never hangs', () => {
  test.each([
    ['4 ^ 0.5 = 2', 'pass'], // fractional exponent: not a rational, old evaluator decides
    ['2 ^ 0.5 = 1.5', 'veto'],
    ['1 / 0 = 0', 'not-checked'],
    ['4 = 4', 'not-checked'], // a restatement, not a claim
    ['2 + x = 4', 'not-checked'],
  ])('%s -> %s', (text, expected) => {
    expect(classifyLocal(text)).toBe(expected);
  });

  test('a power tower is bounded: not-checked, fast, no giant BigInt', () => {
    const started = Date.now();
    expect(classifyLocal('9 ^ 9 ^ 9 ^ 9 = 1')).toBe('not-checked');
    expect(classifyLocal('99 ^ 99 ^ 99 = 1')).toBe('not-checked');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('safeEvalExact', () => {
  test('returns a reduced rational, den > 0', () => {
    expect(safeEvalExact('10 / 4')).toEqual({ ok: true, value: { num: 5n, den: 2n } });
    expect(safeEvalExact('-3 / 6')).toEqual({ ok: true, value: { num: -1n, den: 2n } });
    expect(safeEvalExact('0.25')).toEqual({ ok: true, value: { num: 1n, den: 4n } });
    expect(safeEvalExact('2 ^ -2')).toEqual({ ok: true, value: { num: 1n, den: 4n } });
    expect(safeEvalExact('(-2) ^ 3')).toEqual({ ok: true, value: { num: -8n, den: 1n } });
    expect(safeEvalExact('5 %')).toEqual({ ok: true, value: { num: 1n, den: 20n } });
  });

  test('holds integers past 2^53 without loss', () => {
    expect(safeEvalExact('9007199254740993')).toEqual({ ok: true, value: { num: 9007199254740993n, den: 1n } });
  });

  test('refuses, rather than guesses, what is not a rational or is too large', () => {
    for (const bad of ['', '   ', '2 ^ 0.5', '1 / 0', '0 ^ -1', '2 +', '(1 + 2', 'abc', '9 ^ 9 ^ 9 ^ 9']) {
      const r = safeEvalExact(bad);
      expect(`${bad} -> ${r.ok}`).toBe(`${bad} -> false`);
      expect(typeof r.error).toBe('string');
    }
  });

  test('agrees with the float evaluator wherever both answer', () => {
    // The two share one tokenizer and one set of word-form rewrites; this is the drift check.
    for (const e of ['3 * (4 + 1)', '7 / 8', '2 ^ 10', '15 % * 200', '1,250 + 750', '12 × 3', '10 ÷ 4', '10 percent of 50', '-(2 + 3)']) {
      const f = safeEvalArithmetic(e);
      const x = safeEvalExact(e);
      expect(`${e} exact.ok=${x.ok} float.ok=${f.ok}`).toBe(`${e} exact.ok=${f.ok} float.ok=${f.ok}`);
      if (f.ok && x.ok) expect(Number(x.value!.num) / Number(x.value!.den)).toBeCloseTo(f.value!, 9);
    }
  });
});

describe('through the real route', () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/v1', createClassifyRouter({ limit: 1000, dailyLimit: 0 }));

  test.each([
    ['1000000000 + 1 = 1000000000', 'veto'],
    ['1000000000 + 1 = 1000000001', 'pass'],
    ['9007199254740993 + 0 = 9007199254740992', 'veto'],
  ])('POST /classify %s -> %s, by arithmetic', async (text, label) => {
    const res = await request(app).post('/api/v1/classify').send({ text, labels: ['pass', 'veto', 'not-checked'] });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(label);
    expect(res.body.by).toBe('arithmetic');
  });
});
