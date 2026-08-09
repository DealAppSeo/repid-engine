/**
 * run-frozen-corpus-offline.ts — measure the HAL VETO decision against the
 * FROZEN, HASHED labeled corpus, IN-PROCESS and KEYLESS, and emit a number that
 * carries its own ruler.
 *
 * WHY THIS EXISTS ALONGSIDE run-frozen-corpus.mjs.
 *   run-frozen-corpus.mjs measures the LIVE deployed endpoint — the real
 *   disjoint-family cross-LLM quorum — but needs the fleet up, is rate-limited,
 *   and its first real run scored 1/99 rows behind HTTP 429s. This script needs
 *   NO providers, NO network and NO Supabase: it drives src/hal/lib/evaluate
 *   directly. That makes it reproducible from committed code on any checkout,
 *   which the committed reports/hal-eval/*.LOCAL.json currently is NOT (the
 *   script that produced it was never committed).
 *
 * WHAT IT DOES AND DOES NOT MEASURE — READ THIS BEFORE QUOTING A NUMBER.
 *   With `providers: []` the Layer-1 cross-LLM quorum is SKIPPED (evaluate.ts
 *   gates it on `providers.length > 0`). So this measures the OFFLINE EXTRACTOR
 *   PATH ONLY — the same pure signal path the live score-event pipeline runs at
 *   strictness 1 — NOT the fact-check quorum. The extractor is lexical/heuristic;
 *   it cannot look up whether "Australia's population > Canada's". Its F1 on a
 *   factual TRUE/FALSE corpus is therefore a FLOOR that isolates how much the
 *   quorum adds, not a measure of "is HAL's veto good". The quorum number
 *   requires keys or the live fleet — see run-frozen-corpus.mjs. The ruler string
 *   this script prints says `quorum=NOT-EXERCISED` so the two can never be
 *   confused.
 *
 * HOLDOUT BY DEFAULT. `--split holdout` is the default. The default-veto F1 is
 * the headline. A best-threshold sweep is printed too, labelled `oracle
 * threshold (tuned on THIS split — upper bound, NOT a holdout number)`.
 *
 * Usage:
 *   ts-node scripts/hal-eval/run-frozen-corpus-offline.ts \
 *     [--corpus rigorous-v1|canary-v1] [--split holdout|train|all] \
 *     [--strictness 1|2] [--limit N] [--no-write]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { evaluate } from '../../src/hal/lib/evaluate';
import type { StrictnessLevel } from '../../src/hal/lib/types';

const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const MANIFEST = path.join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json');

export interface CorpusRow {
  id: string;
  prompt: string;
  candidate_answer: string;
  label: string; // TRUE | FALSE | ABSTAIN
  category?: string;
  split?: string; // train | holdout
}

export interface OfflineEvalResult {
  ruler: string;
  corpus: string;
  corpus_sha256: string;
  split: string;
  strictness: number;
  providers: 'NONE';
  quorum: 'NOT-EXERCISED';
  transport: 'in-process src/hal/lib/evaluate (offline extractor)';
  rows: number;
  scored: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** Diagnostic only — tuned on this same split, an UPPER BOUND not a holdout number. */
  oracle_threshold: { t: number; f1: number; precision: number; recall: number };
  /** Mann-Whitney AUC P(score_FALSE > score_TRUE); 0.5 = no separation. */
  auc: number;
  results: Array<{ id: string; truth: string; halScore: number; vetoed: boolean }>;
}

/** Positive class = HALLUCINATION. Ground-truth FALSE means the claim is false. */
const isHallucination = (label: string) => String(label).toUpperCase() === 'FALSE';

/**
 * Re-derive the corpus content hash with the same validator+hasher CI uses.
 * Throws if the file drifted from what MANIFEST.json claims. A measurement of a
 * corpus you cannot name is exactly the failure this rack exists to end.
 */
export function verifyCorpusHash(corpusPath: string, expectedSha256: string): string {
  const out = execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'corpus', 'hash-corpus.mjs'), corpusPath],
    { encoding: 'utf8' },
  );
  const hashed = out.trim().split('\n').pop()!.trim();
  if (hashed !== expectedSha256) {
    throw new Error(
      `REFUSING TO MEASURE — corpus hash mismatch.\n` +
        `  manifest: ${expectedSha256}\n  on disk : ${hashed}\n` +
        `  The corpus changed without the manifest changing; any F1 taken now would be unattributable.`,
    );
  }
  return hashed;
}

/**
 * Pure confusion-matrix + F1 for the VETO decision over already-scored rows.
 * Separated so a test can assert the arithmetic on a known synthetic set without
 * touching the corpus or the extractor.
 */
export function scoreConfusion(
  scored: Array<{ truth: string; vetoed: boolean; halScore: number }>,
): Pick<OfflineEvalResult, 'confusion' | 'precision' | 'recall' | 'f1' | 'accuracy' | 'auc' | 'oracle_threshold'> {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of scored) {
    const truth = isHallucination(r.truth);
    const pred = r.vetoed;
    if (truth && pred) tp++;
    else if (!truth && pred) fp++;
    else if (!truth && !pred) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = scored.length ? (tp + tn) / scored.length : 0;

  // AUC (Mann-Whitney): P(score_FALSE > score_TRUE). 0.5 = no separation.
  const F = scored.filter((r) => isHallucination(r.truth)).map((r) => r.halScore);
  const T = scored.filter((r) => !isHallucination(r.truth)).map((r) => r.halScore);
  let wins = 0, ties = 0;
  for (const f of F) for (const t of T) { if (f > t) wins++; else if (f === t) ties++; }
  const auc = F.length && T.length ? (wins + 0.5 * ties) / (F.length * T.length) : 0.5;

  // Best veto threshold on THIS split (diagnostic upper bound).
  let oracle = { t: 0, f1: 0, precision: 0, recall: 0 };
  for (let t = 0; t <= 1.0001; t += 0.01) {
    let a = 0, b = 0, c = 0;
    for (const r of scored) {
      const veto = r.halScore >= t;
      if (isHallucination(r.truth)) veto ? a++ : c++;
      else if (veto) b++;
    }
    const p = a / (a + b || 1), rc = a / (a + c || 1);
    const ff = (2 * p * rc) / (p + rc || 1);
    if (ff > oracle.f1) oracle = { t: +t.toFixed(2), f1: +ff.toFixed(4), precision: +p.toFixed(4), recall: +rc.toFixed(4) };
  }

  return { confusion: { tp, fp, tn, fn }, precision, recall, f1, accuracy, auc, oracle_threshold: oracle };
}

/** Run the offline extractor over the given rows. No providers → quorum skipped. */
export async function evaluateRowsOffline(
  rows: CorpusRow[],
  strictness: StrictnessLevel,
): Promise<Array<{ id: string; truth: string; halScore: number; vetoed: boolean }>> {
  const out: Array<{ id: string; truth: string; halScore: number; vetoed: boolean }> = [];
  for (const row of rows) {
    const r = await evaluate(row.candidate_answer, row.candidate_answer, {
      domain: 'general',
      certainty: 0.8,
      strictness,
      providers: [], // KEYLESS: Layer-1 disjoint-family quorum is skipped by design
    });
    out.push({ id: row.id, truth: row.label, halScore: +r.hal_score.toFixed(4), vetoed: !!r.vetoed });
  }
  return out;
}

export interface RunOptions {
  corpusName?: string;
  split?: string;
  strictness?: StrictnessLevel;
  limit?: number;
  write?: boolean;
}

export async function runOfflineEval(opts: RunOptions = {}): Promise<OfflineEvalResult> {
  const corpusName = opts.corpusName ?? 'rigorous-v1';
  const split = opts.split ?? 'holdout';
  const strictness = (opts.strictness ?? 1) as StrictnessLevel;
  const limit = opts.limit ?? 0;
  const write = opts.write ?? true;

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entry = manifest.corpora.find((c: any) => c.name === corpusName);
  if (!entry) throw new Error(`No corpus "${corpusName}" in MANIFEST.json`);

  const corpusPath = path.join(ROOT, entry.path);
  const hash = verifyCorpusHash(corpusPath, entry.sha256);
  const ruler = `${entry.name}@${hash.slice(0, 12)} [offline-extractor s=${strictness} providers=NONE quorum=NOT-EXERCISED]`;

  let rows: CorpusRow[] = fs
    .readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (split !== 'all') rows = rows.filter((r) => r.split === split);
  // ABSTAIN rows are not part of the binary veto decision — exclude them.
  rows = rows.filter((r) => String(r.label).toUpperCase() !== 'ABSTAIN');
  if (limit > 0) rows = rows.slice(0, limit);

  const scored = await evaluateRowsOffline(rows, strictness);
  const stats = scoreConfusion(scored);

  const result: OfflineEvalResult = {
    ruler,
    corpus: entry.name,
    corpus_sha256: hash,
    split,
    strictness,
    providers: 'NONE',
    quorum: 'NOT-EXERCISED',
    transport: 'in-process src/hal/lib/evaluate (offline extractor)',
    rows: rows.length,
    scored: scored.length,
    ...stats,
    results: scored,
  };

  if (write) {
    const outDir = path.join(ROOT, 'reports', 'hal-eval');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${entry.name}-${split}-${hash.slice(0, 12)}.OFFLINE.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    result.results = result.results; // keep
    (result as any)._written = path.relative(ROOT, outPath);
  }

  return result;
}

// ---- CLI --------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string, d?: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  const res = await runOfflineEval({
    corpusName: flag('corpus', 'rigorous-v1'),
    split: flag('split', 'holdout'),
    strictness: Number(flag('strictness', '1')) as StrictnessLevel,
    limit: Number(flag('limit', '0')),
    write: !argv.includes('--no-write'),
  });

  console.log(`ruler      : ${res.ruler}`);
  console.log(`transport  : ${res.transport}`);
  console.log(`rows       : ${res.rows}  (scored ${res.scored})`);
  console.log('');
  console.log('=== confusion matrix (positive = hallucination / veto) ===');
  console.log(`  TP ${res.confusion.tp}   FP ${res.confusion.fp}`);
  console.log(`  FN ${res.confusion.fn}   TN ${res.confusion.tn}`);
  console.log('');
  console.log(`  precision ${res.precision.toFixed(4)}`);
  console.log(`  recall    ${res.recall.toFixed(4)}`);
  console.log(`  accuracy  ${res.accuracy.toFixed(4)}`);
  console.log(`  AUC(FALSE>TRUE) ${res.auc.toFixed(4)}  (0.5 = no separation)`);
  console.log('');
  console.log('======================================================================');
  console.log(`  F1 = ${res.f1.toFixed(4)} on ${res.ruler} [${res.split}]`);
  console.log('======================================================================');
  console.log(
    `  oracle threshold (tuned on THIS split — UPPER BOUND, not a holdout number):\n` +
      `    t=${res.oracle_threshold.t}  F1=${res.oracle_threshold.f1}  ` +
      `prec=${res.oracle_threshold.precision}  rec=${res.oracle_threshold.recall}`,
  );
  console.log('');
  console.log(
    `  NOTE: providers=NONE → the disjoint-family cross-LLM QUORUM did not run.\n` +
      `  This is the extractor FLOOR, not "is HAL's veto good". For the quorum number\n` +
      `  use scripts/hal-eval/run-frozen-corpus.mjs against the live keyed endpoint.`,
  );
  if ((res as any)._written) console.log(`\n  written: ${(res as any)._written}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
