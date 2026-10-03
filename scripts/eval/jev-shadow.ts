/**
 * Jev shadow eval (CASCADE_EVAL P3). PREPARED, NOT RUN: running it is a paid call (~$0.0002 for
 * this corpus) and needs Sean's switch. It is not part of CI and is never imported by the app.
 *
 * What it measures: run the existing jevPrefilter (src/hal/jev-prefilter.ts) over a frozen,
 * hashed, public corpus and report what it WOULD have skipped. Shadow only: nothing here
 * changes HAL, and HAL is not called.
 *
 * The number that matters is FALSE SKIPS — a factual claim Jev would have let past the
 * fact-checker. A false skip is worse than a missed skip: a missed skip costs ~1 s of quorum;
 * a false skip means a claim nobody checked.
 *
 * Outcomes (exit code): 0 VERIFIED — ran, report written; 2 NOT_CHECKED — flag or key absent,
 * or every call was unavailable (nothing measured); 1 FAILED — corpus unreadable or hash
 * mismatch. NOT_CHECKED never shares an exit code with a result.
 *
 * Run (only when Sean says so), with HAL_JEV_PREFILTER_ENABLED=true and OPENROUTER_API_KEY set:
 *   npx ts-node scripts/eval/jev-shadow.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface CorpusRow {
  id: string;
  text: string;
  label: 'factual' | 'not_factual';
}

export interface ShadowRow {
  id: string;
  label: CorpusRow['label'];
  /** The prefilter's reason: skipped_not_factual, factual, unavailable, flag_off, refused_scheme. */
  reason: string;
  skip: boolean;
  ms: number;
}

export interface ShadowSummary {
  n: number;
  measured: number;
  unavailable: number;
  would_skip: number;
  would_skip_rate: number | null;
  /** factual rows Jev would have skipped: the dangerous number. */
  false_skips: number;
  false_skip_rate_on_factual: number | null;
  /** not_factual rows Jev correctly skipped. */
  correct_skips: number;
  skip_recall_on_not_factual: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  status: 'VERIFIED' | 'NOT_CHECKED';
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

/** Pure. Unavailable rows are excluded from every rate: a call that did not answer is not a skip or a keep. */
export function summarizeShadow(rows: ShadowRow[]): ShadowSummary {
  const measured = rows.filter((r) => r.reason === 'skipped_not_factual' || r.reason === 'factual');
  const factual = measured.filter((r) => r.label === 'factual');
  const notFactual = measured.filter((r) => r.label === 'not_factual');
  const falseSkips = factual.filter((r) => r.skip).length;
  const correctSkips = notFactual.filter((r) => r.skip).length;
  const wouldSkip = measured.filter((r) => r.skip).length;
  const ms = measured.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n: rows.length,
    measured: measured.length,
    unavailable: rows.length - measured.length,
    would_skip: wouldSkip,
    would_skip_rate: ratio(wouldSkip, measured.length),
    false_skips: falseSkips,
    false_skip_rate_on_factual: ratio(falseSkips, factual.length),
    correct_skips: correctSkips,
    skip_recall_on_not_factual: ratio(correctSkips, notFactual.length),
    p50_ms: pct(ms, 50),
    p95_ms: pct(ms, 95),
    status: measured.length > 0 ? 'VERIFIED' : 'NOT_CHECKED',
  };
}

export function corpusHash(rows: CorpusRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Upper-bound input cost: chars/4 tokens, plus the two fixed questions, at Jev's input price. */
export function estimateCostUsd(rows: CorpusRow[], usdPerMillionInput = 0.042, overheadTokens = 80): number {
  const tokens = rows.reduce((t, r) => t + Math.ceil(r.text.length / 4) + overheadTokens, 0);
  return (tokens / 1_000_000) * usdPerMillionInput;
}

export async function runShadow(
  rows: CorpusRow[],
  decide: (text: string) => Promise<{ skipHal: boolean; reason: string }>,
  now: () => number = () => Date.now(),
): Promise<ShadowRow[]> {
  const out: ShadowRow[] = [];
  for (const r of rows) {
    const t0 = now();
    let reason = 'unavailable';
    let skip = false;
    try {
      const d = await decide(r.text);
      reason = d.reason;
      skip = d.skipHal === true;
    } catch {
      reason = 'unavailable';
    }
    out.push({ id: r.id, label: r.label, reason, skip, ms: Math.max(0, now() - t0) });
  }
  return out;
}

export const CORPUS_PATH = path.join(__dirname, 'jev-shadow-corpus.v1.json');
/** Pinned: the corpus is frozen. Changing it means a new version file and a new hash. */
export const CORPUS_V1_SHA256 = '141c91f02559905e38c004489705de321e8cdce9fd34fc2bc9d01b745366614c';

async function main(): Promise<number> {
  let rows: CorpusRow[];
  try {
    rows = (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { rows: CorpusRow[] }).rows;
  } catch (e) {
    console.log('FAILED');
    console.error(`corpus unreadable: ${(e as Error).message}`);
    return 1;
  }
  const hash = corpusHash(rows);
  if (hash !== CORPUS_V1_SHA256) {
    console.log('FAILED');
    console.error(`corpus hash ${hash} does not match the pinned v1 hash; the corpus is frozen`);
    return 1;
  }
  if (process.env.HAL_JEV_PREFILTER_ENABLED !== 'true' || !process.env.OPENROUTER_API_KEY?.trim()) {
    console.log('NOT CHECKED');
    console.error('needs HAL_JEV_PREFILTER_ENABLED=true and OPENROUTER_API_KEY; nothing was called');
    return 2;
  }
  console.error(`corpus v1 ${hash.slice(0, 12)} · ${rows.length} rows · est. cost ≤ $${estimateCostUsd(rows).toFixed(5)}`);
  const { jevPrefilter, jevModel } = await import('../../src/hal/jev-prefilter');
  const summary = summarizeShadow(await runShadow(rows, (t) => jevPrefilter(t)));
  console.log(summary.status === 'VERIFIED' ? 'VERIFIED' : 'NOT CHECKED');
  console.log(JSON.stringify({ model: jevModel(), corpus: { version: 1, sha256: hash }, ...summary }, null, 2));
  return summary.status === 'VERIFIED' ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code), () => process.exit(1));
}
