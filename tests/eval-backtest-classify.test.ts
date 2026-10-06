/**
 * scripts/eval/backtest-classify.ts — replaying stored voter readings. Nothing here sends a claim:
 * the stored baseline and hand-built rows are the only inputs.
 */
import { join } from 'node:path';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));

import type { VoteOutcome } from '../src/classify/free-votes';
import {
  bootstrap,
  loadBaseline,
  metrics,
  oneUnsure,
  reasonOf,
  report,
  rng,
  rowsFromLive,
  simulateTiebreak,
  tiebreakLabel,
  type Row,
  type TiebreakModel,
} from '../scripts/eval/backtest-classify';

const v = (verdict: 'TRUE' | 'FALSE' | 'UNSURE'): VoteOutcome => ({ kind: 'verdict', verdict });
const row = (truth: 'TRUE' | 'FALSE', a: VoteOutcome | null, b: VoteOutcome | null, label: Row['label']): Row => ({
  row_id: `${truth}-${Math.random()}`,
  truth,
  source: 'test',
  a,
  b,
  label,
});
/** A next() that returns the given values in order, so each branch of the model is chosen on purpose. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++] ?? 0.5;
};
const PERFECT: TiebreakModel = { accuracy: 1, unsure: 0, shared: 0, rule: 'unsure-only' };

describe('metrics', () => {
  it('counts decided stamps and both kinds of wrong stamp, and leaves not-checked out of the rate', () => {
    const m = metrics([
      { truth: 'TRUE', label: 'pass' },
      { truth: 'FALSE', label: 'pass' },
      { truth: 'TRUE', label: 'veto' },
      { truth: 'FALSE', label: 'veto' },
      { truth: 'FALSE', label: 'not-checked' },
    ]);
    expect(m).toEqual({ n: 5, decided: 4, coverage: 0.8, falsePass: 1, trueVeto: 1, wrongRate: 0.5 });
  });

  it('nothing decided is a null rate, never a 0 that reads as no errors', () => {
    expect(metrics([{ truth: 'TRUE', label: 'not-checked' }]).wrongRate).toBeNull();
  });
});

describe('reasonOf', () => {
  it.each([
    [row('TRUE', v('TRUE'), v('TRUE'), 'pass'), 'decided'],
    [row('TRUE', v('UNSURE'), v('UNSURE'), 'not-checked'), 'both_unsure'],
    [row('TRUE', v('TRUE'), v('UNSURE'), 'not-checked'), 'one_unsure'],
    [row('TRUE', v('TRUE'), v('FALSE'), 'not-checked'), 'split'],
    [row('TRUE', v('TRUE'), { kind: 'abstain', reason: 'timeout' }, 'not-checked'), 'no_reading'],
    [row('TRUE', null, v('TRUE'), 'not-checked'), 'no_reading'],
  ] as Array<[Row, string]>)('%#: %s', (r, want) => expect(reasonOf(r)).toBe(want));

  it('oneUnsure says which slot was unsure and how often the other was right', () => {
    const rows = [
      row('TRUE', v('TRUE'), v('UNSURE'), 'not-checked'),
      row('TRUE', v('FALSE'), v('UNSURE'), 'not-checked'),
      row('FALSE', v('UNSURE'), v('FALSE'), 'not-checked'),
      row('TRUE', v('TRUE'), v('TRUE'), 'pass'),
    ];
    expect(oneUnsure(rows)).toEqual({ aUnsure: 1, bUnsure: 2, definiteRight: 2 });
  });
});

describe('tiebreakLabel', () => {
  it('a decided row keeps its label and the third voter is never drawn', () => {
    const next = jest.fn(() => 0);
    expect(tiebreakLabel(row('FALSE', v('TRUE'), v('TRUE'), 'pass'), PERFECT, next)).toBe('pass');
    expect(next).not.toHaveBeenCalled();
  });

  it('one unsure: a third voter agreeing with the definite one decides it', () => {
    expect(tiebreakLabel(row('TRUE', v('TRUE'), v('UNSURE'), 'not-checked'), PERFECT, seq(0.9, 0.9, 0))).toBe('pass');
  });

  it('one unsure and the definite voter wrong: a right third voter leaves it not-checked', () => {
    expect(tiebreakLabel(row('TRUE', v('FALSE'), v('UNSURE'), 'not-checked'), PERFECT, seq(0.9, 0.9, 0))).toBe('not-checked');
  });

  it('a shared mistake turns that row into a wrong stamp: the risk the sweep measures', () => {
    const shared: TiebreakModel = { ...PERFECT, shared: 1 };
    expect(tiebreakLabel(row('TRUE', v('FALSE'), v('UNSURE'), 'not-checked'), shared, seq(0))).toBe('veto');
  });

  it('unsure-only never touches a TRUE/FALSE split; any-split takes the majority of three', () => {
    const split = row('TRUE', v('TRUE'), v('FALSE'), 'not-checked');
    expect(tiebreakLabel(split, PERFECT, seq(0.9, 0.9, 0))).toBe('not-checked');
    expect(tiebreakLabel(split, { ...PERFECT, rule: 'any-split' }, seq(0.9, 0.9, 0))).toBe('pass');
  });

  it('both unsure and no reading stay not-checked under either rule', () => {
    for (const rule of ['unsure-only', 'any-split'] as const) {
      expect(tiebreakLabel(row('TRUE', v('UNSURE'), v('UNSURE'), 'not-checked'), { ...PERFECT, rule }, seq(0))).toBe('not-checked');
      expect(tiebreakLabel(row('TRUE', null, v('TRUE'), 'not-checked'), { ...PERFECT, rule }, seq(0))).toBe('not-checked');
    }
  });
});

describe('reproducible numbers', () => {
  it('the same seed gives the same simulation and the same interval', () => {
    const rows = [row('TRUE', v('TRUE'), v('UNSURE'), 'not-checked'), row('FALSE', v('TRUE'), v('UNSURE'), 'not-checked')];
    const m: TiebreakModel = { accuracy: 0.8, unsure: 0.1, shared: 0.3, rule: 'unsure-only' };
    expect(simulateTiebreak(rows, m, 200, 7)).toEqual(simulateTiebreak(rows, m, 200, 7));
    const stat = (s: number[]) => s.reduce((p, x) => p + x, 0) / s.length;
    expect(bootstrap([1, 2, 3, 4], stat, 200, 7)).toEqual(bootstrap([1, 2, 3, 4], stat, 200, 7));
    const a = rng(1);
    const b = rng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('rowsFromLive', () => {
  const live = [
    // A stand-in qwen on Groq lands in the qwen slot.
    { id: 'r1', truth: 'TRUE', label: 'pass', attempt: 'final', voter_delta: { 'groq:openai/gpt-oss-120b': { verdicts: { TRUE: 1 } }, 'groq:qwen/qwen3.8-27b': { verdicts: { TRUE: 1 } } } },
    // Two readings in one slot (other traffic in the window): null, never a guess.
    { id: 'r2', truth: 'FALSE', label: 'not-checked', attempt: 'final', voter_delta: { 'groq:openai/gpt-oss-120b': { verdicts: { TRUE: 1, FALSE: 1 } }, 'cerebras:qwen-3.8-27b': { verdicts: { UNSURE: 1 } } } },
    // An abstain is a reading.
    { id: 'r3', truth: 'TRUE', label: 'not-checked', attempt: 'final', voter_delta: { 'groq:openai/gpt-oss-120b': { verdicts: { TRUE: 1 } }, 'cerebras:qwen-3.8-27b': { abstains: { cooling: 1 } } } },
    // A first attempt that was retried is not the result.
    { id: 'r4', truth: 'TRUE', label: 'not-checked', attempt: 'first-budget', voter_delta: {} },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  it('maps each family to its slot, keeps abstains, and leaves an ambiguous slot null', () => {
    const rows = rowsFromLive(live, new Map([['r1', 'fever']]));
    expect(rows.map((r) => r.row_id)).toEqual(['r1', 'r2', 'r3']);
    expect(rows[0]).toMatchObject({ source: 'fever', a: v('TRUE'), b: v('TRUE'), label: 'pass' });
    expect(rows[1]!.a).toBeNull();
    expect(rows[1]!.b).toEqual(v('UNSURE'));
    expect(rows[2]!.b).toEqual({ kind: 'abstain', reason: 'cooling' });
    expect(reasonOf(rows[2]!)).toBe('no_reading');
  });
});

describe('the stored baseline', () => {
  const rows = loadBaseline(join(__dirname, '../eval/rigorous'));

  it('replays all 337 rows, and the replayed label is the label production returned', () => {
    expect(rows).toHaveLength(337);
    expect(rows.every((r) => r.source !== 'unknown')).toBe(true);
    // Every decided row whose readings were stored has two agreeing verdicts behind it. A few
    // readings are null (other traffic in the same window; eval/rigorous/README.md says 9), never guessed.
    let unread = 0;
    for (const r of rows) {
      if (r.a === null || r.b === null) {
        unread += 1;
        continue;
      }
      if (r.label === 'pass') expect([r.a, r.b]).toEqual([v('TRUE'), v('TRUE')]);
      if (r.label === 'veto') expect([r.a, r.b]).toEqual([v('FALSE'), v('FALSE')]);
    }
    expect(unread).toBeLessThanOrEqual(9);
  });

  it('the report states the measured rule first and labels the third voter as a simulation', () => {
    const text = report(rows);
    expect(text).toMatch(/^## 1\. The rule as it runs/);
    expect(text).toContain('all: n=337');
    expect(text).toContain('SIMULATED third voter breaking ties (a model, not a measurement)');
  });
});
