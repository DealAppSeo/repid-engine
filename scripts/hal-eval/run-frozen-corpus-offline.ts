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
 *   requires keys or the live fleet — see run-frozen-corpus-local.ts (in-process)
 *   or run-frozen-corpus.mjs (HTTP, retired public sets only). The ruler string
 *   this script prints says `quorum=NOT-EXERCISED` so the two can never be
 *   confused.
 *
 * HOLDOUT BY DEFAULT, AND THE HOLDOUT IS PRIVATE (S60, 2026-10-07). `--split holdout` (the
 * default) reads the private rotating holdout through scripts/eval/holdout.ts and exits 2
 * NOT_CHECKED when no private source is reachable. It never falls back to the public sets. Those
 * (`--split retired-holdout|train|all` with `--corpus`) have been public since July; every number
 * on them carries `holdout: "retired-public"` and a printed line saying it is not a holdout score.
 * A best-threshold sweep is printed too, labelled `oracle threshold (tuned on THIS split — upper
 * bound, NOT a holdout number)`.
 *
 * A private run writes counts only: per-item ids and truth stay out of git. With no checker
 * family in this path, its checker pair is always `incomplete`.
 *
 * Usage:
 *   ts-node scripts/hal-eval/run-frozen-corpus-offline.ts \
 *     [--split holdout|retired-holdout|train|all] [--corpus rigorous-v1|canary-v1] \
 *     [--strictness 1|2] [--limit N] [--no-write]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { evaluate } from '../../src/hal/lib/evaluate';
import type { StrictnessLevel } from '../../src/hal/lib/types';
import {
  exitCodeFor,
  familiesRecord,
  holdoutRuler,
  loadPrivateHoldout,
  VERIFY_PROMPT,
  type CheckerPairRecord,
  type LoadOptions,
} from '../eval/holdout';
import { RETIRED_PUBLIC, retiredLine, retiredStamp } from '../eval/retired-holdout';

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
  /** 'private': the S60 rotating holdout. 'retired-public': a public set, NOT a holdout score. */
  holdout: 'private' | typeof RETIRED_PUBLIC;
  retired_as_holdout?: string;
  /** No checker family runs here, so this is always 'incomplete'. */
  checker_pair: CheckerPairRecord;
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
  /** Where the private holdout is read from (tests inject a temp HOLDOUT_FILE). */
  holdout?: LoadOptions;
}

const PUBLIC_SPLITS = ['retired-holdout', 'train', 'all'];

export async function runOfflineEval(opts: RunOptions = {}): Promise<OfflineEvalResult> {
  const corpusName = opts.corpusName ?? 'rigorous-v1';
  const split = opts.split ?? 'holdout';
  const strictness = (opts.strictness ?? 1) as StrictnessLevel;
  const limit = opts.limit ?? 0;
  const write = opts.write ?? true;

  const measuredAt = new Date().toISOString();
  const tag = `[offline-extractor s=${strictness} providers=NONE quorum=NOT-EXERCISED]`;
  let rows: CorpusRow[];
  let ruler: string;
  let corpus: string;
  let hash: string;
  let stamp: Pick<OfflineEvalResult, 'holdout' | 'retired_as_holdout'>;
  if (split === 'holdout') {
    // The private holdout. Throws HoldoutNotCheckedError (exit 2) when no source is reachable;
    // never falls back to a public set.
    const h = await loadPrivateHoldout(opts.holdout);
    rows = h.items.map((it) => ({ id: it.item_id, prompt: VERIFY_PROMPT, candidate_answer: it.claim, label: it.label, split: 'holdout' }));
    ruler = `${holdoutRuler(h)} ${tag}`;
    corpus = 'private-holdout';
    hash = h.set_sha256;
    stamp = { holdout: 'private' };
  } else {
    if (!PUBLIC_SPLITS.includes(split)) throw new Error(`--split must be holdout (private) or one of ${PUBLIC_SPLITS.join(', ')}`);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const entry = manifest.corpora.find((c: any) => c.name === corpusName);
    if (!entry) throw new Error(`No corpus "${corpusName}" in MANIFEST.json`);

    const corpusPath = path.join(ROOT, entry.path);
    hash = verifyCorpusHash(corpusPath, entry.sha256);
    ruler = `${entry.name}@${hash.slice(0, 12)} ${tag}`;
    corpus = entry.name;
    stamp = retiredStamp();

    rows = fs
      .readFileSync(corpusPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    // 'retired-holdout' is the old public holdout split, kept for regression; it is not a holdout.
    if (split === 'retired-holdout') rows = rows.filter((r) => r.split === 'holdout');
    else if (split !== 'all') rows = rows.filter((r) => r.split === split);
  }
  // ABSTAIN rows are not part of the binary veto decision — exclude them.
  rows = rows.filter((r) => String(r.label).toUpperCase() !== 'ABSTAIN');
  if (limit > 0) rows = rows.slice(0, limit);

  const scored = await evaluateRowsOffline(rows, strictness);
  const stats = scoreConfusion(scored);

  const result: OfflineEvalResult = {
    ruler,
    corpus,
    corpus_sha256: hash,
    split,
    ...stamp,
    checker_pair: familiesRecord([], `offline-${measuredAt}`, measuredAt),
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
    const stem = result.holdout === 'private' ? corpus : `${corpus}-${split}`;
    const outPath = path.join(outDir, `${stem}-${hash.slice(0, 12)}.OFFLINE.json`);
    fs.writeFileSync(outPath, JSON.stringify(diskForm(result), null, 2));
    (result as any)._written = path.relative(ROOT, outPath);
  }

  return result;
}

/**
 * What a run writes to reports/. A private run writes counts only: an item id beside its truth is
 * the label, in git.
 */
export function diskForm(result: OfflineEvalResult): OfflineEvalResult & { results_withheld?: string } {
  if (result.holdout !== 'private') return result;
  return { ...result, results: [], results_withheld: 'private holdout: per-item ids and truth stay out of git' };
}

/**
 * The headline block. A public-set F1 is never printed without the retired line beside it, and a
 * private F1 never without its checker pair status.
 */
export function formatHeadline(res: OfflineEvalResult): string[] {
  const out = [
    '======================================================================',
    `  F1 = ${res.f1.toFixed(4)} on ${res.ruler} [${res.split}]`,
  ];
  if (res.holdout === RETIRED_PUBLIC) out.push(`  ${retiredLine(`${res.corpus} [${res.split}]`)}`);
  else out.push(`  PRIVATE HOLDOUT. checker pair: ${res.checker_pair.status} (offline extractor, no checker family ran)`);
  out.push('======================================================================');
  return out;
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
  for (const line of formatHeadline(res)) console.log(line);
  console.log(
    `  oracle threshold (tuned on THIS split — UPPER BOUND, not a holdout number):\n` +
      `    t=${res.oracle_threshold.t}  F1=${res.oracle_threshold.f1}  ` +
      `prec=${res.oracle_threshold.precision}  rec=${res.oracle_threshold.recall}`,
  );
  console.log('');
  console.log(
    `  NOTE: providers=NONE → the disjoint-family cross-LLM QUORUM did not run.\n` +
      `  This is the extractor FLOOR, not "is HAL's veto good". For the quorum number\n` +
      `  use scripts/hal-eval/run-frozen-corpus-local.ts (in-process, keyed; it reads the\n` +
      `  private holdout too). run-frozen-corpus.mjs reads only the retired public sets.`,
  );
  if ((res as any)._written) console.log(`\n  written: ${(res as any)._written}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    // 2 = NOT_CHECKED (no private holdout reachable), 1 = FAILED. Never 0.
    process.exit(exitCodeFor(e));
  });
}
