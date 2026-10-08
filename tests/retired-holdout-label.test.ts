/**
 * RETIRED AS A HOLDOUT (Sean, BUS S60, 2026-10-07): a score computed on the public sets must never
 * read as a holdout score.
 *
 *   1. The retirement is recorded once, as data, in data/hal_corpus_v1/MANIFEST.json, and every
 *      copy it names exists.
 *   2. DISCOVERY, NOT A LIST: every script under scripts/ that names a retired set is either
 *      LABELLED (prints and/or writes the retired label) or EXEMPT with a reason. A new script that
 *      reads a retired set fails here until it says which. An unused entry fails too, so neither
 *      list can rot.
 *   3. The offline runner's printed headline is checked behaviourally in
 *      tests/hal-frozen-corpus-offline-eval.test.ts; the backtest report's first line in
 *      tests/eval-backtest-classify.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RETIRED_PUBLIC, retiredLine, retiredRecord, retiredStamp } from '../scripts/eval/retired-holdout';

const ROOT = join(__dirname, '..');

/** What names a retired set: any committed copy, the rack's corpus dir, or the stored readings. */
const RETIRED_REF = /rigorous-corpus-v1|canary-corpus-v1|hal_corpus_v1|rigorous-v1\.jsonl|canary-v1\.jsonl|canary-f1-raw|rigorous-raw|baseline-classify-2026-10-05/;

/** Script -> what it must contain. `line`: prints retiredLine; `stamp`: writes the retired fields. */
const LABELLED: Record<string, RegExp[]> = {
  'scripts/hal-eval/run-frozen-corpus-offline.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/hal-eval/run-frozen-corpus-local.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/hal-eval/run-frozen-corpus.mjs': [/RETIRED PUBLIC SET: \$\{set\} is public in git \(retired as a holdout /, /holdout: 'retired-public'/, /\.\.\.RETIRED/],
  'scripts/eval/rigorous-hal-eval.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/eval/canary-f1.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/eval/model-leaderboard.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/eval/candidate-voter.ts': [/retiredLine\(/, /retiredStamp\(/],
  'scripts/eval/backtest-classify.ts': [/retiredLine\(/],
  'scripts/eval/ledger.ts': [/retiredLine\(/],
  'scripts/eval/anfis-lasso.ts': [/retiredLine\(/],
  'scripts/eval/seed-participant-ratings.ts': [/retiredLine\(/],
  'scripts/eval/rigorous-analysis.py': [/RETIRED PUBLIC SET: eval\/rigorous\/rigorous-corpus-v1\.jsonl is public in git \(retired as a holdout /, /"holdout": "retired-public"/],
};

/** Script -> why it prints no score on a retired set. */
const EXEMPT: Record<string, string> = {
  'scripts/eval/build-rigorous-corpus.py': 'builds the rigorous corpus from public benchmarks; computes no score',
  'scripts/corpus/migrate-to-v1-schema.mjs': 'rewrites the corpora into the v1 schema; computes no score',
  'scripts/hal-eval/reskin-invariance.ts': 'measures whether HAL moves under truth-preserving rewrites (invariance), not accuracy against labels',
  'scripts/eval/retired-holdout.ts': 'is the label itself',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|cjs|py)$/.test(name)) out.push(relative(ROOT, p).split('\\').join('/'));
  }
  return out;
}

describe('the retirement is recorded once, as data', () => {
  const rec = retiredRecord();

  it('MANIFEST.json records the date, the reason and every copy', () => {
    expect(rec.date).toBe('2026-10-07');
    expect(rec.reason).toMatch(/public/);
    expect(rec.copies.length).toBeGreaterThanOrEqual(7);
    for (const c of rec.copies) expect(existsSync(join(ROOT, c))).toBe(true);
  });

  it('the label says the set is public and the score is not a holdout score', () => {
    expect(retiredLine('X')).toBe(`RETIRED PUBLIC SET: X is public in git (retired as a holdout ${rec.date}). This is NOT a holdout score.`);
    expect(retiredStamp()).toEqual({ holdout: RETIRED_PUBLIC, retired_as_holdout: rec.date });
  });

  it('a manifest that stops recording the retirement makes the label throw, so no score prints unlabelled', () => {
    expect(() => retiredRecord(join(ROOT, 'package.json'))).toThrow(/does not record the holdout retirement/);
  });
});

describe('every script that names a retired set is labelled or exempt (discovery, not a list)', () => {
  const found = walk(join(ROOT, 'scripts')).filter((f) => RETIRED_REF.test(readFileSync(join(ROOT, f), 'utf8')));

  it('the discovery found the known readers (an empty walk is not a pass)', () => {
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(LABELLED).length);
  });

  it.each(found.map((f) => [f] as const))('%s is labelled or exempt with a reason', (f) => {
    expect(f in LABELLED || f in EXEMPT).toBe(true);
  });

  it.each(Object.entries(LABELLED))('%s carries the retired label', (f, patterns) => {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const p of patterns) expect(src).toMatch(p);
  });

  it('no entry is unused', () => {
    for (const f of [...Object.keys(LABELLED), ...Object.keys(EXEMPT)]) expect(found).toContain(f);
  });
});
