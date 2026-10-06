/**
 * The offline ledger (scripts/eval/ledger.ts) against the stored runs: a reading that was not
 * recorded is skipped, HaluEval is its own class, and the import SQL is idempotent and quoted.
 */
import { join } from 'node:path';
import {
  BASELINE_COLUMNS,
  RUNS,
  baselineResults,
  importSql,
  liveResults,
  loadCorpus,
  loadResults,
  report,
  sqlText,
  taskClass,
} from '../scripts/eval/ledger';

const ROOT = join(__dirname, '..', 'eval', 'rigorous');

describe('loading the stored runs', () => {
  const results = loadResults(ROOT);
  const base = results.filter((r) => r.run_id === RUNS[0].run_id);

  it('the 9 unrecorded readings per checker are skipped, not counted as no answer', () => {
    for (const checker of Object.values(BASELINE_COLUMNS)) {
      expect(base.filter((r) => r.checker === checker)).toHaveLength(337 - 9);
    }
  });

  it('gpt-oss on the baseline: 256 right, 40 wrong, 31 unsure, 1 no answer', () => {
    const corpus = loadCorpus(ROOT);
    const mine = base.filter((r) => r.checker === BASELINE_COLUMNS.groq_gpt_oss_120b);
    const t = { right: 0, wrong: 0, UNSURE: 0, NONE: 0 };
    for (const r of mine) {
      if (r.answer === 'UNSURE' || r.answer === 'NONE') t[r.answer] += 1;
      else if (r.answer === corpus.get(r.row_id)!.label) t.right += 1;
      else t.wrong += 1;
    }
    expect(t).toEqual({ right: 256, wrong: 40, UNSURE: 31, NONE: 1 });
  });

  it('a live delta with more than one reading for a checker is skipped', () => {
    const run = RUNS[1];
    const rows = [
      { id: 'x', voter_delta: { 'groq:a': { verdicts: { TRUE: 1 }, abstains: {} }, 'cerebras:b': { verdicts: { TRUE: 1, FALSE: 1 }, abstains: {} } } },
      { id: 'y', voter_delta: { 'groq:a': { verdicts: {}, abstains: { timeout: 1 } }, 'cerebras:b': { verdicts: {}, abstains: {} } } },
    ];
    const out = liveResults(rows, run);
    expect(out.map((r) => [r.row_id, r.checker, r.answer])).toEqual([
      ['x', 'groq:a', 'TRUE'],
      ['y', 'groq:a', 'NONE'],
    ]);
  });

  it('baselineResults reads the two named columns only', () => {
    const out = baselineResults(
      [{ row_id: 'r', label_truth: 'TRUE', groq_gpt_oss_120b: 'abstain:unparseable', cerebras_qwen_3_8_27b: null, production_label: 'not-checked' }],
      RUNS[0],
    );
    expect(out).toEqual([expect.objectContaining({ checker: 'groq:openai/gpt-oss-120b', answer: 'NONE' })]);
  });
});

describe('task classes', () => {
  it('HaluEval is always qa-answer, whatever its domain', () => {
    expect(taskClass('halueval', 'qa-knowledge')).toBe('qa-answer');
    expect(taskClass('halueval', 'medicine')).toBe('qa-answer');
  });
  it('health, money, arithmetic, misconception, encyclopedic, general', () => {
    expect(taskClass('truthfulqa', 'truthfulqa/Health')).toBe('health');
    expect(taskClass('truthfulqa', 'truthfulqa/Finance')).toBe('money');
    expect(taskClass('canary', 'mathematics')).toBe('arithmetic');
    expect(taskClass('truthfulqa', 'truthfulqa/Law')).toBe('misconception');
    expect(taskClass('fever', 'fact-verification')).toBe('encyclopedic');
    expect(taskClass('canary', 'geography')).toBe('general');
  });
});

describe('report', () => {
  const text = report(ROOT);
  it('names the head-to-head and the 16 flat contradictions on the baseline', () => {
    expect(text).toContain('Flat contradictions (one TRUE, one FALSE): 16.');
    expect(text).toMatch(/groq:openai\/gpt-oss-120b right on 8, cerebras:qwen-3\.8-27b on 8/);
  });
  it('a slice under 100 shows counts only, never a percentage', () => {
    const small = text.split('\n').filter((l) => l.includes('rerun-2026-10-06'));
    expect(small.length).toBeGreaterThan(0);
    for (const l of small) expect(l).toContain('under 100: counts only');
  });
});

describe('import SQL', () => {
  it('quotes text, refuses NUL', () => {
    expect(sqlText("it's")).toBe("'it''s'");
    expect(() => sqlText('a\u0000b')).toThrow();
  });
  it('every statement is idempotent', () => {
    const files = importSql(loadCorpus(ROOT), loadResults(ROOT));
    const stmts = files.join('').split('\n').filter((l) => l.trim());
    expect(stmts.length).toBeGreaterThan(337);
    for (const s of stmts) expect(s).toMatch(/on conflict \(.+\) do nothing;$/);
  });
});
