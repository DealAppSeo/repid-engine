/**
 * The HAL execution floor has no super-linear regex on the public /evaluate path (CC1 2026-10-14).
 *
 * POST /api/v1/hal/evaluate is unauthenticated and caps `text` at 8,000 chars. Every request runs
 * HalService.evaluate -> applyExecutionFloor -> extractTypedClaims -> matchArithRelation, flag OFF
 * included (shadow mode). The old ARITH_RELATION_WORD, /(.+?)\s+(equals|...)\s+(.+)/i, was cubic
 * on a failing input: 'a' + 7998 spaces + 'b' blocked the event loop for ~16 minutes.
 * #1377 timed only extractHALSignals; this file times the path the route runs.
 *
 *   1. Differential: the new regexes return what the old ones did, over a seeded fuzz corpus.
 *   2. Snapshot: extractTypedClaims() is unchanged against a snapshot taken on main (04f77e83).
 *   3. Route depth: scanForInjection + HalService.evaluate stay under budget on hostile inputs.
 */
// markDegraded pages the operator from the no-provider fallback; keep that off the network.
jest.mock('../src/services/operator-pager', () => ({
  ...jest.requireActual('../src/services/operator-pager'),
  pageOperator: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ARITH_RELATION_SYMBOLIC,
  ARITH_RELATION_WORD,
  extractTypedClaims,
  segmentClaims,
} from '../src/hal/claim-typing';
import { HalService } from '../src/hal/service';
import { scanForInjection } from '../src/hal/injection-guard';

// The forms on main before this change, verbatim. Only ever run on short strings here.
const OLD_SYMBOLIC = /^(.*?)\s*(==|<=|>=|!=|≠|≈|=|<|>)\s*([^=<>≠≈]+)$/;
const OLD_WORD = /(.+?)\s+(equals|is equal to|is|approximately)\s+(.+)/i;

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** What recognizeArithmetic reads from a match: null-ness and the three trimmed captures. */
const view = (m: RegExpMatchArray | null): string =>
  m === null
    ? 'null'
    : JSON.stringify([(m[1] ?? '').trim(), (m[2] ?? '').trim().toLowerCase(), (m[3] ?? '').trim()]);

const timed = async <T>(fn: () => Promise<T> | T): Promise<{ out: T; ms: number }> => {
  const t = performance.now();
  const out = await fn();
  return { out, ms: performance.now() - t };
};

describe('1. the new relation regexes match the old ones (differential)', () => {
  // Seeded, so a divergence reproduces.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const TOKENS = [
    '2', '10.5', '3', '0', '+', '-', '*', '/', '%', '(', ')', '=', '==', '<=', '>=', '!=', '<', '>', '≈', '≠',
    '!', ' is ', ' equals ', ' is equal to ', ' approximately ', ' IS ', 'is', 'the total', 'of', 'percent',
    '.', '?', ',', ' ', '  ', '\t', '\r', '\n', LS, PS, '- ', '* ', 'x', 'a',
  ];
  const STRINGS = 25_000;

  test(`${STRINGS} seeded strings, every segment: zero divergences`, () => {
    const rnd = mulberry32(20261014);
    const divergences: string[] = [];
    let segments = 0;
    let symbolicHits = 0;
    let wordHits = 0;
    for (let i = 0; i < STRINGS; i++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < len; j++) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
      for (const seg of segmentClaims(s)) {
        segments++;
        const oldS = view(seg.match(OLD_SYMBOLIC));
        const oldW = view(seg.match(OLD_WORD));
        if (oldS !== 'null') symbolicHits++;
        if (oldW !== 'null') wordHits++;
        if (oldS !== view(seg.match(ARITH_RELATION_SYMBOLIC))) divergences.push(`SYMBOLIC ${JSON.stringify(seg)}`);
        if (oldW !== view(seg.match(ARITH_RELATION_WORD))) divergences.push(`WORD ${JSON.stringify(seg)}`);
      }
    }
    expect(divergences).toEqual([]);
    // The corpus has to exercise both regexes, on both outcomes, or "zero divergences" is cheap.
    expect(segments).toBeGreaterThan(STRINGS);
    expect(symbolicHits).toBeGreaterThan(5_000);
    expect(wordHits).toBeGreaterThan(5_000);
    expect(segments - symbolicHits).toBeGreaterThan(5_000);
  });

  // The case a simpler linear form gets wrong: `.` stops at a line terminator but `\s` does not,
  // so the old `(.*?)\s*` spans a \r or U+2028 in the gap before the operator.
  test.each([
    ['2 + 2\r= 4'],
    ['2 + 2 \r\t= 4'],
    [`2 + 2${LS}= 4`],
    [`2 + 2 ${PS} <= 5`],
    ['2 + 2 \r is 4'],
    ['x\r 2 + 2 is 4'],
  ])('line terminator before the operator: %j', (s) => {
    expect(view(s.match(ARITH_RELATION_SYMBOLIC))).toBe(view(s.match(OLD_SYMBOLIC)));
    expect(view(s.match(ARITH_RELATION_WORD))).toBe(view(s.match(OLD_WORD)));
  });
});

describe('2. extractTypedClaims is unchanged against the snapshot taken on main', () => {
  const snapshot = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'execution-floor-typeclaim-main-snapshot.json'), 'utf8'),
  ) as Array<{ input: string; claims: unknown[] }>;

  test('the snapshot covers the execution-floor test inputs and arithmetic claims', () => {
    expect(snapshot.length).toBeGreaterThanOrEqual(50);
    const arithmetic = snapshot.flatMap((s) => s.claims).filter((c: any) => c.executableKind === 'arithmetic');
    expect(arithmetic.length).toBeGreaterThanOrEqual(20);
  });

  test.each(snapshot.map((s) => [JSON.stringify(s.input), s] as const))('%s', (_label, s) => {
    expect(extractTypedClaims(s.input)).toEqual(s.claims);
  });
});

describe('3. route depth: scanForInjection + HalService.evaluate on 8,000-char hostile input', () => {
  const MAX = 8000; // the route's cap, src/routes/hal-evaluate.ts
  const BUDGET_MS = 300;
  const fill = (unit: string, n = MAX): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const PAYLOADS: Array<[string, string]> = [
    ["'a' + spaces + 'b' (one trimmed segment, the 16-minute input)", 'a' + ' '.repeat(MAX - 2) + 'b'],
    ["'a' + spaces", 'a' + ' '.repeat(MAX - 1)],
    ["('a = ') repeated", fill('a = ')],
    ["'a=' + spaces + '='", 'a=' + ' '.repeat(MAX - 3) + '='],
    ["('x is ') repeated", fill('x is ')],
    ["'1' x 8000", '1'.repeat(MAX)],
    ['\\r / U+2028 / U+2029 mix', fill(`a \r ${LS} = ${PS} is `)],
    ["'a' + tabs + 'b'", 'a' + '\t'.repeat(MAX - 2) + 'b'],
    ["'x is' + spaces", 'x is' + ' '.repeat(MAX - 4)],
    ["'1 =' + spaces + '<'", '1 =' + ' '.repeat(MAX - 4) + '<'],
    ["'a' + (' ' + '\\r') repeated + 'b'", 'a' + fill(' \r', MAX - 2) + 'b'],
    ['deep parentheses = 2', fill('(', 3996) + '1+1' + fill(')', 3996) + ' = 2' + ' '],
    ["('1 + ') repeated = 5 (a 2,000-term sum the evaluator runs)", fill('1 + ', MAX - 8) + '1 = 5' + '   '],
    ['0x + a hex run too long for an address or tx hash', '0x' + 'a'.repeat(MAX - 2)],
    ['DOI prefix + dashes', '10.1234/' + '-'.repeat(MAX - 8)],
    ['arXiv: + spaces', 'arXiv:' + ' '.repeat(MAX - 7) + 'x'],
    ["('https://') repeated", fill('https://')],
    ['backtick + letters', '`' + 'a'.repeat(MAX - 1)],
    ['function + spaces', 'function' + ' '.repeat(MAX - 9) + '!'],
  ];
  // Providers stubbed to none: strictness 2 (the route default) then takes the local
  // extractor-fallback, so nothing leaves the process and every millisecond is CPU.
  const svc = new HalService(() => []);
  const prevJev = process.env.HAL_JEV_PREFILTER_ENABLED;

  let warn: jest.SpyInstance;

  beforeAll(async () => {
    // The fallback is LOUD by design (DEGRADED, UNEARNED VETO SUPPRESSED); that is not under test.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.HAL_JEV_PREFILTER_ENABLED;
    await svc.evaluate({ text: 'warm up: 2 + 2 = 4', strictness: 2 } as any);
  });
  afterAll(() => {
    warn.mockRestore();
    if (prevJev === undefined) delete process.env.HAL_JEV_PREFILTER_ENABLED;
    else process.env.HAL_JEV_PREFILTER_ENABLED = prevJev;
  });

  test.each(PAYLOADS)(`%s: under ${BUDGET_MS} ms`, async (_name, text) => {
    expect(text.length).toBe(MAX);
    const { out, ms } = await timed(async () => {
      scanForInjection(text);
      return svc.evaluate({ text, strictness: 2 } as any);
    });
    // The floor ran to completion. On a throw, evaluate() returns HAL without it, which would
    // make a fast time meaningless.
    expect(out.execution_floor).toBeDefined();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test('the budget has teeth: the OLD word regex is super-linear, the new one is not', () => {
    // Ratios on one machine, not wall-clock. CI's runner did the OLD regex at 1,000 chars in 189 ms
    // against ~1.9 s on the dev box, so "OLD takes > 300 ms" was a fact about the box and went red
    // on main. Cubic grows ~8x per doubling; a linear OLD (the test lost its teeth) grows ~2x.
    const input = (n: number) => 'a' + ' '.repeat(n - 2) + 'b';
    const fastest = (re: RegExp, s: string) =>
      Math.min(
        ...[0, 1, 2].map(() => {
          const t = performance.now();
          expect(s.match(re)).toBeNull();
          return performance.now() - t;
        }),
      );
    const old400 = fastest(OLD_WORD, input(400));
    const old800 = fastest(OLD_WORD, input(800));
    const new800 = fastest(ARITH_RELATION_WORD, input(800));
    expect(old800 / old400).toBeGreaterThanOrEqual(4);
    expect(old800 / Math.max(new800, 0.01)).toBeGreaterThanOrEqual(50);
  });
});
