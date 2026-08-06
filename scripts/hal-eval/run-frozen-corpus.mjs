#!/usr/bin/env node
/**
 * run-frozen-corpus.mjs — measure HAL against a HASHED corpus, through the live
 * public endpoint, and emit a number that carries its own ruler.
 *
 * WHY THIS EXISTS ALONGSIDE run-labeled-corpus.ts. That script reads
 * `hal_test_cases` from Supabase — 2,517 rows, mutable, unhashed, editable
 * between two runs with no record. A number taken against it cannot be compared
 * to a number taken against it yesterday, which is how HAL ended up with four
 * F1s (0.34 / 0.74 / 0.886 / 0.890) that settle nothing. This one reads the
 * frozen JSONL and REFUSES TO RUN if the file no longer hashes to what
 * MANIFEST.json claims.
 *
 * That refusal is the entire point. A measurement tool that will happily measure
 * a corpus it cannot identify reproduces the problem it was built to end.
 *
 * HOLDOUT BY DEFAULT. Reporting accuracy on rows used for tuning measures recall
 * of the training set. `--split holdout` is the default; `--split all` is
 * available and is labelled as such in the output so it can never be quoted as
 * a holdout number by accident.
 *
 * KEYLESS, VIA THE DEPLOYED ENGINE. Uses POST /api/v1/hal/evaluate — the same
 * public path `trustshell verify` uses and any integrator gets. So this measures
 * PRODUCTION behaviour, not a local build with a different provider set. The
 * cost is that it is rate-limited and slow; the benefit is that the number
 * describes the thing users actually hit.
 *
 * Usage:
 *   node scripts/hal-eval/run-frozen-corpus.mjs [--corpus rigorous-v1]
 *        [--split holdout|train|all] [--limit N] [--concurrency 3]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.join(import.meta.dirname, '..', '..'));
const MANIFEST = path.join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json');
const ENGINE = process.env.TRUSTSHELL_API_URL || 'https://repid-engine-production.up.railway.app';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const corpusName = flag('corpus', 'rigorous-v1');
const split = flag('split', 'holdout');
const limit = Number(flag('limit', '0'));
const concurrency = Math.max(1, Number(flag('concurrency', '3')));

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entry = manifest.corpora.find((c) => c.name === corpusName);
if (!entry) { console.error(`No corpus "${corpusName}" in MANIFEST.json`); process.exit(2); }

// ---- THE HASH GATE -------------------------------------------------------
// Re-derive the hash with the same validator+hasher CI uses. If the file has
// drifted from what the manifest claims, STOP. Do not measure something you
// cannot name.
const hashed = execFileSync('node', [path.join(ROOT, 'scripts', 'corpus', 'hash-corpus.mjs'), path.join(ROOT, entry.path)], { encoding: 'utf8' })
  .trim().split('\n').pop().trim();
if (hashed !== entry.sha256) {
  console.error(`REFUSING TO MEASURE — corpus hash mismatch.`);
  console.error(`  manifest: ${entry.sha256}`);
  console.error(`  on disk : ${hashed}`);
  console.error(`  The corpus changed without the manifest changing. Any F1 taken now would be`);
  console.error(`  unattributable. Update MANIFEST.json in the same commit as the corpus edit.`);
  process.exit(1);
}
const RULER = `${entry.name}@${hashed.slice(0, 12)}`;

let rows = fs.readFileSync(path.join(ROOT, entry.path), 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
if (split !== 'all') rows = rows.filter((r) => r.split === split);
if (limit > 0) rows = rows.slice(0, limit);

console.log(`ruler      : ${RULER}`);
console.log(`split      : ${split}${split === 'all' ? '  ** INCLUDES TRAIN — not a holdout number **' : ''}`);
console.log(`rows       : ${rows.length}`);
console.log(`engine     : ${ENGINE}`);
console.log(`answer_mode: ${entry.answer_mode}`);
console.log('');

/** Positive class = HALLUCINATION. Ground-truth FALSE means the claim is false. */
const isHallucination = (label) => String(label).toUpperCase() === 'FALSE';

async function evaluateOne(row, attempt = 0) {
  try {
    const res = await fetch(`${ENGINE}/api/v1/hal/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: row.candidate_answer, context: { domain: 'general', certainty: 0.8 }, strictness: 2 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) return { id: row.id, error: `HTTP ${res.status}` };
    const j = await res.json();
    return {
      id: row.id,
      truth: row.label,
      verdict: j.verdict ?? j.decision ?? null,
      halScore: j.halScore ?? j.hal_score ?? null,
      mode: j.mode ?? null,
      providers: j.providersUsed ?? j.providers_used ?? null,
      families: j.familiesUsed ?? j.families_used ?? null,
    };
  } catch (e) {
    // Rate limits and transport faults are NOT quality signals. Back off and
    // retry; if it still fails, record it as an ERROR, never as a wrong answer.
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
      return evaluateOne(row, attempt + 1);
    }
    return { id: row.id, truth: row.label, error: String(e.message || e).slice(0, 80) };
  }
}

const results = [];
let done = 0;
const queue = [...rows];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const r = await evaluateOne(row);
      results.push(r);
      done++;
      if (done % 10 === 0 || done === rows.length) process.stdout.write(`\r  evaluated ${done}/${rows.length}`);
    }
  }),
);
console.log('\n');

const errors = results.filter((r) => r.error);
const scored = results.filter((r) => !r.error && r.verdict);

// verdict -> predicted hallucination. 'vetoed' is the hard call; 'flagged' is
// soft and counted as NOT-hallucination, matching the SDK's `ok` semantics
// (PASS and soft FLAG both proceed).
const predictedHallucination = (v) => String(v).toLowerCase() === 'vetoed' || String(v).toLowerCase() === 'veto';

let tp = 0, fp = 0, tn = 0, fn = 0;
for (const r of scored) {
  const truth = isHallucination(r.truth);
  const pred = predictedHallucination(r.verdict);
  if (truth && pred) tp++;
  else if (!truth && pred) fp++;
  else if (!truth && !pred) tn++;
  else fn++;
}
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
const accuracy = scored.length ? (tp + tn) / scored.length : 0;

const verdicts = scored.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
const famSeen = [...new Set(scored.map((r) => r.families).filter(Boolean))];

console.log('=== confusion matrix (positive = hallucination) ===');
console.log(`  TP ${tp}   FP ${fp}`);
console.log(`  FN ${fn}   TN ${tn}`);
console.log('');
console.log(`  precision ${precision.toFixed(4)}`);
console.log(`  recall    ${recall.toFixed(4)}`);
console.log(`  accuracy  ${accuracy.toFixed(4)}`);
console.log('');
console.log(`  scored ${scored.length} / ${rows.length}   errors ${errors.length}`);
console.log(`  verdicts ${JSON.stringify(verdicts)}`);
console.log('');

// RULE 24: a measurement without its ruler is not a result.
const familyQual = famSeen.length ? `${famSeen.join('/')} families` : 'family count not reported by endpoint';

/**
 * THE COVERAGE GATE — added after this script's first real run.
 *
 * That run scored 1 of 99 rows (98x HTTP 429) and printed
 * "F1 = 0.0000 on rigorous-v1@596f10de18d0" as its headline, with the error
 * count relegated to a NOTE underneath. The number was arithmetically correct
 * and completely meaningless: an F1 over a single row. Anyone skimming the
 * output — or grepping it later — would have read a catastrophic HAL
 * regression that never happened.
 *
 * That is precisely the failure this whole corpus effort exists to end: a
 * component emitting a number it had no basis for. Excluding the errors from
 * the matrix was not enough; the headline itself has to refuse.
 *
 * So: below MIN_COVERAGE the script prints NO F1 at all, states why, and exits
 * non-zero. A transport failure must be impossible to mistake for a quality
 * result, including by the tool that produced it.
 */
const MIN_COVERAGE = Number(process.env.HAL_EVAL_MIN_COVERAGE ?? '0.8');
const coverage = rows.length ? scored.length / rows.length : 0;

console.log('======================================================================');
if (coverage < MIN_COVERAGE) {
  console.log(`  NO F1 REPORTED — coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${rows.length}) is below the ${(MIN_COVERAGE * 100).toFixed(0)}% floor.`);
  console.log(`  ${errors.length} row(s) failed in transport, not in judgement.`);
  const kinds = errors.reduce((a, e) => ((a[e.error] = (a[e.error] ?? 0) + 1), a), {});
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`     ${n}x  ${k}`);
  console.log(`  This is NOT a HAL quality measurement and must not be quoted as one.`);
  console.log('======================================================================');
  fs.mkdirSync(path.join(ROOT, 'reports', 'hal-eval'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'reports', 'hal-eval', `${entry.name}-${split}-${hashed.slice(0, 12)}.INCOMPLETE.json`),
    JSON.stringify({ ruler: RULER, split, coverage, scored: scored.length, rows: rows.length, errors: errors.length, error_kinds: kinds, f1: null, reason: 'coverage below floor — transport failure, not a quality result' }, null, 2),
  );
  process.exit(3);
}
console.log(`  F1 = ${f1.toFixed(4)} on ${RULER} [${split}] at ${familyQual}`);
console.log(`  coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${rows.length})`);
console.log('======================================================================');
if (errors.length) console.log(`  NOTE: ${errors.length} row(s) errored (transport/rate-limit), EXCLUDED from the matrix — not counted as wrong answers.`);

const outPath = path.join(ROOT, 'reports', 'hal-eval', `${entry.name}-${split}-${hashed.slice(0, 12)}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  ruler: RULER, corpus: entry.name, corpus_sha256: hashed, split, answer_mode: entry.answer_mode,
  engine: ENGINE, rows: rows.length, scored: scored.length, errors: errors.length,
  confusion: { tp, fp, tn, fn }, precision, recall, f1, accuracy, verdicts,
  results,
}, null, 2));
console.log(`\n  written: ${path.relative(ROOT, outPath)}`);
