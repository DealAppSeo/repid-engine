/**
 * BACKTEST AND MONTE CARLO for POST /api/v1/classify, from stored per-voter readings. No provider
 * call, no production call, no quota spent.
 *
 *   npm run eval:backtest-classify
 *   npm run eval:backtest-classify -- --compare <live.jsonl>     # a re-run, paired by row_id
 *
 * WHY. A label is the agreement of two voters (combineVotes), so every rule we might tune (when to
 * ask a question, whether a third family breaks a tie) is a function of the two readings production
 * already stored for 337 labelled claims (eval/rigorous/baseline-classify-2026-10-05.jsonl). Replaying
 * those readings answers "what would this rule have done" without sending a single claim, and
 * leaves Groq's shared 1,000 a day for live users (2026-10-05: eval traffic spent it once).
 *
 * WHAT IT REPORTS.
 * 1. The rule as it runs: coverage, wrong stamps, with 95% bootstrap intervals (seeded, so a re-run
 *    prints the same numbers).
 * 2. Why each not-checked was not-checked: both unsure, one unsure, a TRUE/FALSE split, no reading.
 * 3. How often each question trigger would fire: both UNSURE (today) or one UNSURE.
 * 4. A SIMULATED third voter breaking ties, swept over its accuracy and over how often it repeats
 *    the wrong voter's mistake. This is a model of a voter, not a measurement of one: it says what
 *    accuracy a tiebreaker must have before it lowers the wrong-stamp rate, which is the number to
 *    measure a real candidate against (eval:candidate-voter).
 * 5. With --compare, the change from the stored run to a re-run, row by row.
 *
 * HaluEval rows are reported apart: its FALSE means "a bad answer to a question", not always a
 * false statement (eval/rigorous/README.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoteLabel, VoteOutcome } from '../../src/classify/free-votes';
import { outcomeOf, type BaselineRow } from './candidate-voter';

export type Truth = 'TRUE' | 'FALSE';

export interface Row {
  row_id: string;
  truth: Truth;
  source: string;
  /** The gpt-oss slot's reading, or null when the stored reading was ambiguous. */
  a: VoteOutcome | null;
  /** The qwen slot's reading, or null when ambiguous. */
  b: VoteOutcome | null;
  /** The label production returned on that run. */
  label: VoteLabel;
}

export interface Metrics {
  n: number;
  decided: number;
  coverage: number;
  /** FALSE claims stamped Checks out. */
  falsePass: number;
  /** TRUE claims stamped Caught. */
  trueVeto: number;
  /** Wrong stamps over decided stamps; null when nothing was decided. */
  wrongRate: number | null;
}

export function metrics(rows: ReadonlyArray<{ truth: Truth; label: VoteLabel }>): Metrics {
  let decided = 0;
  let falsePass = 0;
  let trueVeto = 0;
  for (const r of rows) {
    if (r.label === 'not-checked') continue;
    decided += 1;
    if (r.label === 'pass' && r.truth === 'FALSE') falsePass += 1;
    if (r.label === 'veto' && r.truth === 'TRUE') trueVeto += 1;
  }
  return {
    n: rows.length,
    decided,
    coverage: rows.length ? decided / rows.length : 0,
    falsePass,
    trueVeto,
    wrongRate: decided ? (falsePass + trueVeto) / decided : null,
  };
}

/** mulberry32: a small seeded PRNG, so every interval and simulation here is reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

/** 95% percentile-bootstrap interval of a statistic over rows resampled with replacement. */
export function bootstrap<T>(rows: readonly T[], stat: (sample: T[]) => number | null, trials = 2000, seed = 20261006) {
  const next = rng(seed);
  const values: number[] = [];
  for (let t = 0; t < trials; t += 1) {
    const sample: T[] = [];
    for (let i = 0; i < rows.length; i += 1) sample.push(rows[Math.floor(next() * rows.length)]!);
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  values.sort((x, y) => x - y);
  return { lo: quantile(values, 0.025), hi: quantile(values, 0.975) };
}

export type Reason = 'decided' | 'both_unsure' | 'one_unsure' | 'split' | 'no_reading';

const verdictOf = (o: VoteOutcome | null) => (o && o.kind === 'verdict' ? o.verdict : null);

/** Why a row got its label. 'no_reading' covers an abstain on either side and an ambiguous stored reading. */
export function reasonOf(row: Pick<Row, 'a' | 'b' | 'label'>): Reason {
  if (row.label !== 'not-checked') return 'decided';
  const a = verdictOf(row.a);
  const b = verdictOf(row.b);
  if (a === null || b === null) return 'no_reading';
  if (a === 'UNSURE' && b === 'UNSURE') return 'both_unsure';
  if (a === 'UNSURE' || b === 'UNSURE') return 'one_unsure';
  return 'split';
}

/** On one-UNSURE rows: which slot was unsure, and how often the other slot's TRUE/FALSE was right. */
export function oneUnsure(rows: readonly Row[]) {
  let aUnsure = 0;
  let bUnsure = 0;
  let definiteRight = 0;
  for (const r of rows) {
    if (reasonOf(r) !== 'one_unsure') continue;
    const a = verdictOf(r.a);
    const b = verdictOf(r.b);
    if (a === 'UNSURE') aUnsure += 1;
    else bUnsure += 1;
    if ((a === 'UNSURE' ? b : a) === r.truth) definiteRight += 1;
  }
  return { aUnsure, bUnsure, definiteRight };
}

export interface TiebreakModel {
  /** Probability the third voter gives the right TRUE/FALSE when it does not answer UNSURE. */
  accuracy: number;
  /** Probability it answers UNSURE. */
  unsure: number;
  /**
   * Probability that, when one of the first two gave a wrong TRUE/FALSE, the third repeats that same
   * mistake regardless of its own accuracy. 0 is an independent voter; real models trained on
   * overlapping data share mistakes, so the sweep never assumes 0 alone.
   */
  shared: number;
  /** 'unsure-only': consulted when one voter said UNSURE. 'any-split': also on a TRUE/FALSE split. */
  rule: 'unsure-only' | 'any-split';
}

/**
 * One simulated label for a row under a tiebreak rule. A row already decided keeps its label (the
 * third voter is not asked), and a row with no reading stays not-checked (THE FALLBACK covers those).
 */
export function tiebreakLabel(row: Row, m: TiebreakModel, next: () => number): VoteLabel {
  const reason = reasonOf(row);
  if (reason === 'decided' || reason === 'no_reading' || reason === 'both_unsure') return row.label;
  if (reason === 'split' && m.rule === 'unsure-only') return row.label;
  const a = verdictOf(row.a)!;
  const b = verdictOf(row.b)!;
  const right: 'TRUE' | 'FALSE' = row.truth;
  const wrong: 'TRUE' | 'FALSE' = right === 'TRUE' ? 'FALSE' : 'TRUE';
  const definite = [a, b].filter((v): v is 'TRUE' | 'FALSE' => v !== 'UNSURE');
  const someoneWrong = definite.includes(wrong);
  let third: 'TRUE' | 'FALSE' | 'UNSURE';
  if (someoneWrong && next() < m.shared) third = wrong;
  else if (next() < m.unsure) third = 'UNSURE';
  else third = next() < m.accuracy ? right : wrong;
  const votes = [...definite, third];
  const t = votes.filter((v) => v === 'TRUE').length;
  const f = votes.filter((v) => v === 'FALSE').length;
  if (t >= 2 && f === 0) return 'pass';
  if (f >= 2 && t === 0) return 'veto';
  if (m.rule === 'any-split' && t >= 2 && t > f) return 'pass';
  if (m.rule === 'any-split' && f >= 2 && f > t) return 'veto';
  return 'not-checked';
}

/** Mean and 95% band of coverage and wrong stamps over `trials` simulated runs of the tiebreak. */
export function simulateTiebreak(rows: readonly Row[], m: TiebreakModel, trials = 2000, seed = 20261006) {
  const next = rng(seed);
  const cover: number[] = [];
  const wrong: number[] = [];
  for (let t = 0; t < trials; t += 1) {
    const labelled = rows.map((r) => ({ truth: r.truth, label: tiebreakLabel(r, m, next) }));
    const s = metrics(labelled);
    cover.push(s.coverage);
    wrong.push(s.falsePass + s.trueVeto);
  }
  cover.sort((x, y) => x - y);
  wrong.sort((x, y) => x - y);
  const mean = (xs: number[]) => xs.reduce((p, x) => p + x, 0) / xs.length;
  return {
    coverage: { mean: mean(cover), lo: quantile(cover, 0.025), hi: quantile(cover, 0.975) },
    wrongStamps: { mean: mean(wrong), lo: quantile(wrong, 0.025), hi: quantile(wrong, 0.975) },
  };
}

/** Stored baseline rows joined to the corpus for source and truth. */
export function loadBaseline(root: string): Row[] {
  const corpus = new Map<string, { source: string }>();
  for (const line of readFileSync(join(root, 'rigorous-corpus-v1.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { row_id: string; source: string };
    corpus.set(r.row_id, { source: r.source });
  }
  const rows: Row[] = [];
  for (const line of readFileSync(join(root, 'baseline-classify-2026-10-05.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const b = JSON.parse(line) as BaselineRow;
    rows.push({
      row_id: b.row_id,
      truth: b.label_truth,
      source: corpus.get(b.row_id)?.source ?? 'unknown',
      a: outcomeOf(b.groq_gpt_oss_120b),
      b: outcomeOf(b.cerebras_qwen_3_8_27b),
      label: b.production_label,
    });
  }
  return rows;
}

interface LiveRecord {
  id: string;
  truth: Truth;
  label: VoteLabel | null;
  attempt?: string;
  voter_delta?: Record<string, { verdicts?: Record<string, number>; abstains?: Record<string, number> }> | null;
}

/**
 * A re-run recorded by the live runner (one JSON object a line: id, truth, label, voter_delta from
 * /classify/stats around the call). The gpt-oss slot is any gpt-oss voter and the qwen slot any qwen
 * voter, so a stand-in on another host still lands in its slot. A slot with no single reading is null.
 */
export function rowsFromLive(text: string, sources: ReadonlyMap<string, string>): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as LiveRecord;
    if (r.attempt && r.attempt !== 'final') continue;
    if (r.label !== 'pass' && r.label !== 'veto' && r.label !== 'not-checked') continue;
    const slot = (family: RegExp): VoteOutcome | null => {
      if (!r.voter_delta) return null;
      const seen: VoteOutcome[] = [];
      for (const [voter, d] of Object.entries(r.voter_delta)) {
        if (!family.test(voter)) continue;
        for (const [v, n] of Object.entries(d.verdicts ?? {})) for (let i = 0; i < n; i += 1) seen.push(outcomeOf(v)!);
        for (const [reason, n] of Object.entries(d.abstains ?? {})) for (let i = 0; i < n; i += 1) seen.push(outcomeOf(`abstain:${reason}`)!);
      }
      return seen.length === 1 ? seen[0]! : null;
    };
    rows.push({
      row_id: r.id,
      truth: r.truth,
      source: sources.get(r.id) ?? 'unknown',
      a: slot(/gpt-oss/),
      b: slot(/qwen/),
      label: r.label,
    });
  }
  return rows;
}

const pct = (x: number | null) => (x === null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function block(title: string, rows: Row[]): string[] {
  const m = metrics(rows);
  const cov = bootstrap(rows, (s) => metrics(s).coverage);
  const wr = bootstrap(rows, (s) => metrics(s).wrongRate);
  const falses = rows.filter((r) => r.truth === 'FALSE');
  const fp = bootstrap(falses, (s) => (s.length ? metrics(s).falsePass / s.length : null));
  return [
    `${title}: n=${m.n}, decided ${m.decided} = ${pct(m.coverage)} [${pct(cov.lo)}-${pct(cov.hi)}]; ` +
      `wrong stamps ${m.falsePass + m.trueVeto} (${m.falsePass} false shown Checks out, ${m.trueVeto} true shown Caught) = ` +
      `${pct(m.wrongRate)} of decided [${pct(wr.lo)}-${pct(wr.hi)}]; ` +
      `false claims shown Checks out ${m.falsePass}/${falses.length} = ${pct(falses.length ? m.falsePass / falses.length : null)} [${pct(fp.lo)}-${pct(fp.hi)}]`,
  ];
}

export function report(rows: Row[], compare?: Row[]): string {
  const out: string[] = [];
  const noHalu = rows.filter((r) => r.source !== 'halueval');
  out.push('## 1. The rule as it runs (stored readings, 95% bootstrap intervals)');
  out.push(...block('all', rows), ...block('without HaluEval', noHalu));
  for (const src of [...new Set(rows.map((r) => r.source))].sort()) out.push(...block(src, rows.filter((r) => r.source === src)));

  out.push('', '## 2. Why each not-checked was not-checked');
  const reasons = new Map<Reason, number>();
  for (const r of rows) reasons.set(reasonOf(r), (reasons.get(reasonOf(r)) ?? 0) + 1);
  for (const k of ['decided', 'both_unsure', 'one_unsure', 'split', 'no_reading'] as Reason[]) out.push(`${k}: ${reasons.get(k) ?? 0}`);
  const one = oneUnsure(rows);
  out.push(
    `one_unsure, by who was unsure: gpt-oss ${one.aUnsure}, qwen ${one.bUnsure}. ` +
      `The other voter's TRUE/FALSE was right on ${one.definiteRight} of ${one.aUnsure + one.bUnsure} ` +
      `(${pct(one.aUnsure + one.bUnsure ? one.definiteRight / (one.aUnsure + one.bUnsure) : null)}): the ceiling on what any tiebreaker can recover there.`,
  );

  out.push('', '## 3. Question triggers (how many not-checked rows would get a question call)');
  out.push(`both UNSURE (the rule today): ${reasons.get('both_unsure') ?? 0} of ${rows.length}`);
  out.push(`at least one UNSURE, no TRUE/FALSE contradiction: ${(reasons.get('both_unsure') ?? 0) + (reasons.get('one_unsure') ?? 0)} of ${rows.length}`);

  out.push('', '## 4. SIMULATED third voter breaking ties (a model, not a measurement)');
  const base = metrics(rows);
  out.push(`today: coverage ${pct(base.coverage)}, wrong stamps ${base.falsePass + base.trueVeto}`);
  for (const rule of ['unsure-only', 'any-split'] as const) {
    for (const shared of [0, 0.3, 0.6]) {
      const cells: string[] = [];
      for (const accuracy of [0.7, 0.8, 0.9, 0.95]) {
        const s = simulateTiebreak(rows, { accuracy, unsure: 0.15, shared, rule });
        cells.push(`acc ${accuracy}: cov ${pct(s.coverage.mean)}, wrong ${s.wrongStamps.mean.toFixed(1)} [${s.wrongStamps.lo}-${s.wrongStamps.hi}]`);
      }
      out.push(`${rule}, shared mistakes ${shared}: ${cells.join(' | ')}`);
    }
  }

  if (compare) {
    out.push('', '## 5. Stored run -> re-run, paired by row');
    const before = new Map(rows.map((r) => [r.row_id, r]));
    const paired = compare.filter((r) => before.has(r.row_id));
    const was = paired.map((r) => before.get(r.row_id)!);
    out.push(...block('stored, same rows', was), ...block('re-run', paired));
    const moves = new Map<string, number>();
    for (const r of paired) {
      const k = `${before.get(r.row_id)!.label} -> ${r.label}`;
      moves.set(k, (moves.get(k) ?? 0) + 1);
    }
    out.push('transitions: ' + [...moves.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', '));
    const rr = new Map<Reason, number>();
    for (const r of paired) rr.set(reasonOf(r), (rr.get(reasonOf(r)) ?? 0) + 1);
    out.push('re-run reasons: ' + [...rr.entries()].map(([k, n]) => `${k} ${n}`).join(', '));
  }
  return out.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const root = join(__dirname, '../../eval/rigorous');
  const rows = loadBaseline(root);
  const comparePath = arg('compare');
  let compare: Row[] | undefined;
  if (comparePath) {
    const sources = new Map(rows.map((r) => [r.row_id, r.source]));
    compare = rowsFromLive(readFileSync(comparePath, 'utf8'), sources);
  }
  process.stdout.write(report(rows, compare) + '\n');
}
