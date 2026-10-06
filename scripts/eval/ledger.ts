/**
 * CHECKER LEDGER, OFFLINE (Sean, 2026-10-06). No network, no model call, no database.
 *
 *   npx ts-node scripts/eval/ledger.ts report
 *       Scores every checker in the stored labelled runs: k = 3, 95% range, and counts only (no
 *       rate) under 100 answers. Also the two checkers head to head on the same claims, and how
 *       often they flatly contradicted each other.
 *
 *   npx ts-node scripts/eval/ledger.ts import-sql [outDir]
 *       Writes idempotent SQL (out/ledger-import/NN.sql by default) that loads the corpus into
 *       ledger_items and the stored runs into ledger_eval_results, once the ledger migration
 *       (supabase/migrations/20261006150000_checker_ledger.sql) is applied. Re-running it inserts
 *       nothing twice.
 *
 * A READING THAT WAS NOT RECORDED IS SKIPPED, NEVER GUESSED. The 2026-10-05 baseline has 9 rows per
 * checker where other traffic landed in the same stats window, stored as null. They are not "no
 * answer": they are not known, so they do not enter the ledger at all.
 *
 * HALUEVAL IS ITS OWN CLASS. Its FALSE means "a bad answer to the question", and several of its
 * FALSE rows are true sentences (eval/rigorous/answer-key-audit-2026-10-06.md). It is scored under
 * task class `qa-answer`, never blended into a checker's truth rate.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoteOutcome } from '../../src/classify/free-votes';
import { comparePaired, contradicted, readSlice, type Answer, type PairedItem, type SliceCounts } from '../../src/ledger/score';
import { outcomeOf, type BaselineRow } from './candidate-voter';

export type Truth = 'TRUE' | 'FALSE';

export interface CorpusRow {
  row_id: string;
  source: string;
  claim: string;
  label: Truth;
  domain: string;
}

export interface Result {
  run_id: string;
  row_id: string;
  checker: string;
  prompt_version: string;
  answer: Answer;
  at: string;
}

/** Baseline column -> the checker it recorded (eval/rigorous/README.md). */
export const BASELINE_COLUMNS: Readonly<Record<'groq_gpt_oss_120b' | 'cerebras_qwen_3_8_27b', string>> = {
  groq_gpt_oss_120b: 'groq:openai/gpt-oss-120b',
  cerebras_qwen_3_8_27b: 'cerebras:qwen-3.8-27b',
};

/** The stored runs. prompt_version is a dated label, not a hash: the prompt text was not recorded. */
export const RUNS = [
  { run_id: 'baseline-2026-10-05', file: 'baseline-classify-2026-10-05.jsonl', prompt_version: 'label:2026-10-05-default', at: '2026-10-05T00:00:00Z' },
  { run_id: 'rerun-2026-10-06-assumptions-on', file: 'rerun-assumptions-on-2026-10-06.jsonl', prompt_version: 'label:2026-10-06-assumptions-on', at: '2026-10-06T06:50:00Z' },
] as const;

/** v1 task classes. Coarse on purpose: a class needs 100 answers before it shows a rate. */
export function taskClass(source: string, domain: string): string {
  if (source === 'halueval') return 'qa-answer';
  if (domain === 'mathematics') return 'arithmetic';
  if (['medicine', 'truthfulqa/Health', 'truthfulqa/Nutrition'].includes(domain)) return 'health';
  if (['truthfulqa/Finance', 'truthfulqa/Economics'].includes(domain)) return 'money';
  if (domain === 'fact-verification') return 'encyclopedic';
  if (domain.startsWith('truthfulqa/') || domain === 'common_misconception') return 'misconception';
  return 'general';
}

export function answerOf(o: VoteOutcome | null): Answer | null {
  if (o === null) return null;
  return o.kind === 'verdict' ? o.verdict : 'NONE';
}

function jsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function loadCorpus(root: string): Map<string, CorpusRow> {
  return new Map(jsonl<CorpusRow>(join(root, 'rigorous-corpus-v1.jsonl')).map((r) => [r.row_id, r]));
}

export function baselineResults(rows: readonly BaselineRow[], run: (typeof RUNS)[number]): Result[] {
  const out: Result[] = [];
  for (const r of rows) {
    for (const [col, checker] of Object.entries(BASELINE_COLUMNS) as Array<[keyof typeof BASELINE_COLUMNS, string]>) {
      const answer = answerOf(outcomeOf(r[col]));
      if (answer === null) continue;
      out.push({ run_id: run.run_id, row_id: r.row_id, checker, prompt_version: run.prompt_version, answer, at: run.at });
    }
  }
  return out;
}

interface LiveRow {
  id: string;
  at?: string;
  voter_delta?: Record<string, { verdicts?: Record<string, number>; abstains?: Record<string, number> }> | null;
}

/**
 * A live re-run: per checker, exactly one reading in the stats delta around the call, or nothing.
 * Two readings in one window means other traffic landed there: skipped, never guessed.
 */
export function liveResults(rows: readonly LiveRow[], run: (typeof RUNS)[number]): Result[] {
  const out: Result[] = [];
  for (const r of rows) {
    for (const [checker, d] of Object.entries(r.voter_delta ?? {})) {
      const verdicts = Object.entries(d.verdicts ?? {}).filter(([, n]) => n > 0);
      const abstains = Object.values(d.abstains ?? {}).reduce((a, n) => a + n, 0);
      const total = verdicts.reduce((a, [, n]) => a + n, 0) + abstains;
      if (total !== 1) continue;
      const answer: Answer = verdicts.length === 1 ? (verdicts[0]![0] as Answer) : 'NONE';
      if (!['TRUE', 'FALSE', 'UNSURE', 'NONE'].includes(answer)) continue;
      out.push({ run_id: run.run_id, row_id: r.id, checker, prompt_version: run.prompt_version, answer, at: r.at ?? run.at });
    }
  }
  return out;
}

export function loadResults(root: string): Result[] {
  const [baseline, rerun] = RUNS;
  return [
    ...baselineResults(jsonl<BaselineRow>(join(root, baseline.file)), baseline),
    ...liveResults(jsonl<LiveRow>(join(root, rerun.file)), rerun),
  ];
}

function countsOf(results: readonly Result[], corpus: ReadonlyMap<string, CorpusRow>): SliceCounts {
  const c: SliceCounts = { right: 0, wrong: 0, unsure: 0, none: 0 };
  for (const r of results) {
    const truth = corpus.get(r.row_id)?.label;
    if (!truth) continue;
    if (r.answer === 'UNSURE') c.unsure += 1;
    else if (r.answer === 'NONE') c.none += 1;
    else if (r.answer === truth) c.right += 1;
    else c.wrong += 1;
  }
  return c;
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`;
}

export function report(root: string): string {
  const corpus = loadCorpus(root);
  const results = loadResults(root);
  const lines: string[] = ['# Checker ledger (offline, k = 3)', ''];
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const g = `${r.run_id}\t${r.checker}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  lines.push('| run | checker | n | right | wrong | unsure | none | right when answered (95%) | score/claim | shown |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const [g, rs] of [...groups.entries()].sort()) {
    const [run, checker] = g.split('\t');
    const c = countsOf(rs, corpus);
    const s = readSlice(c);
    const range = s.precisionRange ? `${pct(s.precision)} (${pct(s.precisionRange.lo)}-${pct(s.precisionRange.hi)})` : 'n/a';
    lines.push(
      `| ${run} | ${checker} | ${s.n} | ${c.right} | ${c.wrong} | ${c.unsure} | ${c.none} | ${s.shown ? range : 'under 100: counts only'} | ${s.shown && s.perClaim !== null ? s.perClaim.toFixed(3) : '-'} | ${s.shown ? 'yes' : 'no'} |`,
    );
  }

  const base = results.filter((r) => r.run_id === RUNS[0].run_id);
  const byItem = new Map<string, Partial<Record<string, Answer>>>();
  for (const r of base) byItem.set(r.row_id, { ...(byItem.get(r.row_id) ?? {}), [r.checker]: r.answer });
  const [ca, cb] = Object.values(BASELINE_COLUMNS) as [string, string];
  const paired: PairedItem[] = [];
  let contra = 0;
  let contraARight = 0;
  for (const [row_id, m] of byItem) {
    const truth = corpus.get(row_id)?.label;
    const a = m[ca];
    const b = m[cb];
    if (!truth || !a || !b) continue;
    paired.push({ truth, a, b });
    if (contradicted(a, b)) {
      contra += 1;
      if (a === truth) contraARight += 1;
    }
  }
  const cmp = comparePaired(paired);
  lines.push('', `## Head to head on the same ${cmp.items} claims (${RUNS[0].run_id})`, '');
  lines.push(
    `Worth under k = 3, ${ca} minus ${cb}: ${cmp.difference} (paired z = ${cmp.z.toFixed(2)}, p = ${cmp.p.toFixed(3)}). ` +
      `${ca} did better on ${cmp.aBetter} claims and ${cb} on ${cmp.bBetter}; the count alone is not the verdict, the size is.`,
  );
  lines.push(`Flat contradictions (one TRUE, one FALSE): ${contra}. ${ca} right on ${contraARight}, ${cb} on ${contra - contraARight}.`);

  lines.push('', '## By task class, all runs (counts only under 100)', '');
  lines.push('| checker | class | n | right | wrong | unsure | none | right when answered (95%) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const byClass = new Map<string, Result[]>();
  for (const r of results) {
    const row = corpus.get(r.row_id);
    if (!row) continue;
    const g = `${r.checker}\t${taskClass(row.source, row.domain)}`;
    byClass.set(g, [...(byClass.get(g) ?? []), r]);
  }
  for (const [g, rs] of [...byClass.entries()].sort()) {
    const [checker, cls] = g.split('\t');
    const c = countsOf(rs, corpus);
    const s = readSlice(c);
    const range = s.shown && s.precisionRange ? `${pct(s.precision)} (${pct(s.precisionRange.lo)}-${pct(s.precisionRange.hi)})` : 'counts only';
    lines.push(`| ${checker} | ${cls} | ${s.n} | ${c.right} | ${c.wrong} | ${c.unsure} | ${c.none} | ${range} |`);
  }
  return lines.join('\n');
}

/** A SQL string literal. Our own corpus text only; NUL is refused rather than escaped. */
export function sqlText(s: string): string {
  if (s.includes('\u0000')) throw new Error('NUL in text');
  return `'${s.replace(/'/g, "''")}'`;
}

export function importSql(corpus: ReadonlyMap<string, CorpusRow>, results: readonly Result[], chunk = 150): string[] {
  const stmts: string[] = [];
  for (const r of corpus.values()) {
    stmts.push(
      `insert into public.ledger_items (source, source_id, claim, truth, task_class, holdout) values (` +
        `${sqlText(r.source)}, ${sqlText(r.row_id)}, ${sqlText(r.claim)}, ${sqlText(r.label)}, ` +
        `${sqlText(taskClass(r.source, r.domain))}, false) on conflict (source, source_id) do nothing;`,
    );
  }
  for (const r of results) {
    const item = corpus.get(r.row_id);
    if (!item) continue;
    stmts.push(
      `insert into public.ledger_eval_results (run_id, item_id, checker, prompt_version, engine_commit, answer, created_at) ` +
        `select ${sqlText(r.run_id)}, i.id, ${sqlText(r.checker)}, ${sqlText(r.prompt_version)}, null, ${sqlText(r.answer)}, ${sqlText(r.at)}::timestamptz ` +
        `from public.ledger_items i where i.source = ${sqlText(item.source)} and i.source_id = ${sqlText(item.row_id)} ` +
        `on conflict (run_id, item_id, checker) do nothing;`,
    );
  }
  const files: string[] = [];
  for (let i = 0; i < stmts.length; i += chunk) files.push(stmts.slice(i, i + chunk).join('\n') + '\n');
  return files;
}

function main(): void {
  const root = join(__dirname, '..', '..', 'eval', 'rigorous');
  const [cmd, outDir] = process.argv.slice(2);
  if (cmd === 'report') {
    console.log(report(root));
    return;
  }
  if (cmd === 'import-sql') {
    const dir = outDir ?? join(__dirname, '..', '..', 'out', 'ledger-import');
    mkdirSync(dir, { recursive: true });
    const files = importSql(loadCorpus(root), loadResults(root));
    files.forEach((sql, i) => writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}.sql`), sql));
    console.log(`${files.length} files in ${dir}`);
    return;
  }
  console.error('usage: ledger.ts report | import-sql [outDir]');
  process.exit(2);
}

if (require.main === module) main();
