/**
 * run-frozen-corpus-local.ts — LEG 2: measure HAL against the frozen corpus
 * IN-PROCESS, with no HTTP and therefore no public rate cap.
 *
 * WHY THIS AND NOT THE HTTP RUNNER. scripts/hal-eval/run-frozen-corpus.mjs goes
 * through POST /api/v1/hal/evaluate, which is capped at 10 requests per 24h per
 * IP (HAL_PUBLIC_RATE_LIMIT). A 99-row holdout cannot complete through it —
 * three attempts today produced 98/99, 15/15 and 6/6 HTTP 429s. That cap is
 * correct for anonymous traffic and useless for measurement.
 *
 * Calling halService.evaluate() directly removes the transport entirely. Same
 * scoring code the deployed engine runs, same providers, no network in between.
 *
 * SECRET HANDLING. Provider keys are loaded from .env.master by dotenv INSIDE
 * this process and never leave it. No shell export, no echo, no interpolation
 * into a command line. Earlier today a bare `export` in a shell pipeline printed
 * the whole environment and leaked two live credentials; this path cannot do
 * that because the values never reach a shell at all.
 *
 * THE TWO GATES, same as the HTTP runner:
 *   HASH     refuses to measure a corpus that does not match MANIFEST.json
 *   COVERAGE refuses to print an F1 below 80% scored — a transport or provider
 *            failure must never be reportable as a quality result
 *
 * Usage:
 *   npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts [--corpus rigorous-v1]
 *        [--split holdout|train|all] [--limit N] [--concurrency 4]
 */
import 'dotenv/config';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { isHallucination, confusionMatrix, prf1, rocAuc } from './metrics';

// Load the key inventory in-process. Values are never printed, never exported,
// never placed on a command line.
const MASTER = process.env.ENV_MASTER_PATH || 'C:/Users/Cash4/repos/.env.master';
if (fs.existsSync(MASTER)) dotenv.config({ path: MASTER });

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json');

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : d;
};
const corpusName = flag('corpus', 'rigorous-v1');
const split = flag('split', 'holdout');
const limit = Number(flag('limit', '0'));
const concurrency = Math.max(1, Number(flag('concurrency', '4')));
const MIN_COVERAGE = Number(process.env.HAL_EVAL_MIN_COVERAGE ?? '0.8');

interface CorpusEntry {
  name: string;
  path: string;
  sha256: string;
  answer_mode: string;
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { corpora: CorpusEntry[] };
const entry = manifest.corpora.find((c) => c.name === corpusName);
if (!entry) {
  console.error(`No corpus "${corpusName}" in MANIFEST.json`);
  process.exit(2);
}

// ── HASH GATE ───────────────────────────────────────────────────────────────
const hashed = execFileSync(
  'node',
  [path.join(ROOT, 'scripts', 'corpus', 'hash-corpus.mjs'), path.join(ROOT, entry!.path)],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .pop()!
  .trim();

if (hashed !== entry!.sha256) {
  console.error('REFUSING TO MEASURE — corpus hash mismatch.');
  console.error(`  manifest: ${entry!.sha256}`);
  console.error(`  on disk : ${hashed}`);
  console.error('  Any F1 taken now would be unattributable to a known ruler.');
  process.exit(1);
}
const RULER = `${entry!.name}@${hashed.slice(0, 12)}`;

interface Row {
  id: string;
  prompt: string;
  candidate_answer: string;
  label: string;
  split: string;
}
let rows: Row[] = fs
  .readFileSync(path.join(ROOT, entry!.path), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);
if (split !== 'all') rows = rows.filter((r) => r.split === split);
if (limit > 0) rows = rows.slice(0, limit);

interface Scored {
  id: string;
  truth: string;
  verdict?: string;
  halScore?: number;
  mode?: string;
  familiesUsed?: number;
  families?: string[];
  error?: string;
}

(async () => {
  console.log(`ruler      : ${RULER}`);
  console.log(`split      : ${split}${split === 'all' ? '  ** INCLUDES TRAIN — not a holdout number **' : ''}`);
  console.log(`rows       : ${rows.length}`);
  console.log(`transport  : IN-PROCESS halService (no HTTP, no public rate cap)`);
  console.log(`answer_mode: ${entry!.answer_mode}`);
  console.log('');

  // Required (not `await import`) AFTER dotenv, for two reasons:
  //   - this repo is "type": "commonjs"; ts-node resolves a dynamic import as
  //     ESM and fails with ERR_MODULE_NOT_FOUND on a real, present file.
  //   - the require must happen after dotenv so provider keys exist at module
  //     init — halService reads them when it is constructed, not per call.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { halService } = require('../../src/hal/service') as { halService: { evaluate: (i: unknown) => Promise<unknown> } };

  const results: Scored[] = [];
  const queue = [...rows];
  let done = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const row = queue.shift()!;
        try {
          const r: any = await halService.evaluate({
            text: row.candidate_answer,
            context: { domain: 'general', certainty: 0.8 },
            strictness: 2,
          });
          const sig = (r?.signals ?? {}) as Record<string, unknown>;
          results.push({
            id: row.id,
            truth: row.label,
            verdict: r?.verdict ?? r?.decision,
            halScore: r?.halScore ?? r?.hal_score,
            mode: r?.mode,
            familiesUsed: typeof sig.families_used === 'number' ? (sig.families_used as number) : undefined,
            families: Array.isArray(sig.families) ? (sig.families as string[]) : undefined,
          });
        } catch (e: any) {
          // A provider failure is NOT a wrong answer. Recorded separately and
          // excluded from the matrix — the mistake that once reported a dead
          // key as a math regression.
          results.push({ id: row.id, truth: row.label, error: String(e?.message ?? e).slice(0, 90) });
        }
        done++;
        if (done % 5 === 0 || done === rows.length) process.stdout.write(`\r  evaluated ${done}/${rows.length}`);
      }
    }),
  );
  console.log('\n');

  const errors = results.filter((r) => r.error);
  const scored = results.filter((r) => !r.error && r.verdict);

  const { tp, fp, tn, fn } = confusionMatrix(scored);
  const { precision, recall, f1, accuracy } = prf1({ tp, fp, tn, fn });
  const coverage = rows.length ? scored.length / rows.length : 0;

  // ROC AUC over the continuous halScore (rows with a numeric score only).
  const aucPoints = scored
    .filter((r) => typeof r.halScore === 'number' && Number.isFinite(r.halScore))
    .map((r) => ({ score: r.halScore as number, positive: isHallucination(r.truth) }));
  const auc = rocAuc(aucPoints);

  // PROVIDER SET THAT ACTUALLY ANSWERED — the ruler is only valid with this named.
  // Count how many scored rows each family voted in, and the quorum-width histogram.
  const familyParticipation: Record<string, number> = {};
  const quorumWidthHist: Record<string, number> = {};
  let factCheckRows = 0;
  let fallbackRows = 0;
  for (const r of scored) {
    if (r.mode === 'fact-check') factCheckRows++;
    else fallbackRows++;
    if (typeof r.familiesUsed === 'number') quorumWidthHist[String(r.familiesUsed)] = (quorumWidthHist[String(r.familiesUsed)] ?? 0) + 1;
    for (const fam of r.families ?? []) familyParticipation[fam] = (familyParticipation[fam] ?? 0) + 1;
  }

  console.log('=== confusion matrix (positive = hallucination) ===');
  console.log(`  TP ${tp}   FP ${fp}`);
  console.log(`  FN ${fn}   TN ${tn}`);
  console.log('');
  console.log(`  precision ${precision.toFixed(4)}`);
  console.log(`  recall    ${recall.toFixed(4)}`);
  console.log(`  accuracy  ${accuracy.toFixed(4)}`);
  console.log(`  scored ${scored.length}/${rows.length}   errors ${errors.length}`);
  const verdicts = scored.reduce<Record<string, number>>(
    (a, r) => ((a[String(r.verdict)] = (a[String(r.verdict)] ?? 0) + 1), a),
    {},
  );
  console.log(`  verdicts ${JSON.stringify(verdicts)}`);
  console.log(`  AUC       ${auc == null ? 'undefined (single class)' : auc.toFixed(4)}   (ranks continuous halScore; F1 is at the veto threshold — different question)`);
  console.log('');
  console.log('=== provider set that ANSWERED (the ruler is only valid with this named) ===');
  console.log(`  fact-check rows ${factCheckRows}/${scored.length}   extractor-fallback rows ${fallbackRows}/${scored.length}`);
  console.log(`  quorum-width histogram (families that voted per row): ${JSON.stringify(quorumWidthHist)}`);
  console.log(`  family participation (scored rows each family voted in): ${JSON.stringify(familyParticipation)}`);
  console.log('');

  const outDir = path.join(ROOT, 'reports', 'hal-eval');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('======================================================================');
  if (coverage < MIN_COVERAGE) {
    console.log(`  NO F1 REPORTED — coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${rows.length}) below the ${(MIN_COVERAGE * 100).toFixed(0)}% floor.`);
    const kinds = errors.reduce<Record<string, number>>((a, e) => ((a[e.error!] = (a[e.error!] ?? 0) + 1), a), {});
    for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`     ${n}x  ${k}`);
    console.log('  This is NOT a HAL quality measurement and must not be quoted as one.');
    console.log('======================================================================');
    fs.writeFileSync(
      path.join(outDir, `${entry!.name}-${split}-${hashed.slice(0, 12)}.LOCAL.INCOMPLETE.json`),
      JSON.stringify({ ruler: RULER, split, coverage, scored: scored.length, rows: rows.length, errors: errors.length, error_kinds: kinds, f1: null }, null, 2),
    );
    process.exit(3);
  }

  console.log(`  F1 = ${f1.toFixed(4)} on ${RULER} [${split}] — in-process, strictness 2`);
  console.log(`  precision ${precision.toFixed(4)}  recall ${recall.toFixed(4)}  AUC ${auc == null ? 'n/a' : auc.toFixed(4)}`);
  console.log(`  coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${rows.length})`);
  console.log(`  families that answered: [${Object.keys(familyParticipation).join(', ')}]`);
  console.log('======================================================================');

  fs.writeFileSync(
    path.join(outDir, `${entry!.name}-${split}-${hashed.slice(0, 12)}.LOCAL.json`),
    JSON.stringify(
      {
        ruler: RULER,
        corpus_sha256: hashed,
        split,
        answer_mode: entry!.answer_mode,
        transport: 'in-process halService',
        strictness: 2,
        concurrency,
        rows: rows.length,
        scored: scored.length,
        errors: errors.length,
        confusion: { tp, fp, tn, fn },
        precision,
        recall,
        f1,
        accuracy,
        auc,
        verdicts,
        provider_set: {
          fact_check_rows: factCheckRows,
          extractor_fallback_rows: fallbackRows,
          quorum_width_histogram: quorumWidthHist,
          family_participation: familyParticipation,
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n  written: reports/hal-eval/${entry!.name}-${split}-${hashed.slice(0, 12)}.LOCAL.json`);
})();
