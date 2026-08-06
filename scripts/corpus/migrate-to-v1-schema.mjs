#!/usr/bin/env node
/**
 * migrate-to-v1-schema.mjs — make the shipped corpora conform to the schema the
 * rack already enforces, so `hash-corpus.mjs` can actually emit a hash.
 *
 * THE PROBLEM THIS SOLVES. data/hal_corpus_v1/SCHEMA.md and hash-corpus.mjs
 * define a 9-key row and reject anything else outright. The three corpora
 * shipped alongside them use entirely different key sets — the only field all
 * of them share is `label`. So the validator has never successfully hashed the
 * corpora it lives next to, and every HAL F1 to date (0.34 / 0.74 / 0.886 /
 * 0.890) was taken on an unhashed, unfrozen ruler. tests/corpus-rack.test.ts
 * passes 8/8 because it exercises the validator against synthetic fixtures and
 * never points it at the real files.
 *
 * WHAT THIS DOES NOT DO. It does not invent evidence. Rows whose source URL is
 * not an absolute http(s) URL are DROPPED, not patched with a plausible link —
 * the provenance gate exists because an agent once produced 162 "independent"
 * examples that were all self-generated, and satisfying that gate with a
 * fabricated URL would be the same failure with better manners. Dropped rows
 * are reported by id.
 *
 * `source_retrieved_at` is the corpus file's own git commit date, passed in by
 * the caller. That is a real, checkable fact about when the rows were captured.
 * It is not a per-row retrieval timestamp, and the notes field says so rather
 * than letting a precise-looking timestamp imply precision nobody measured.
 *
 * THE ONE DECISION THIS SCRIPT DOES NOT MAKE — --answer-mode.
 * The schema wants (prompt, candidate_answer); the corpora are (claim, label).
 * How you bridge that decides WHAT IS BEING MEASURED, which per SCHEMA.md is
 * Sean's call, not this script's:
 *
 *   claim-as-answer (default) — prompt is a fixed verification instruction and
 *     candidate_answer is the claim. Measures "can HAL judge whether a claim is
 *     true", uniformly across all 387 rows. This is what HAL is actually asked
 *     to do in production today.
 *
 *   recover-qa — for the 190 rows built `qa->statement`, split the embedded
 *     "Q: ... A: ..." back into prompt and candidate_answer; the other 197 rows
 *     have no question to recover and fall back to claim-as-answer. Measures
 *     answer-grounding for some rows and claim-checking for others.
 *
 * RECOMMENDATION: claim-as-answer. `recover-qa` puts two different measurements
 * under one F1 — the exact ruler-mixing this rack was built to end, reintroduced
 * inside a single corpus file. Use recover-qa only to build a SEPARATE corpus
 * whose hash and name say so.
 *
 * Usage:
 *   node scripts/corpus/migrate-to-v1-schema.mjs <in.jsonl> <out.jsonl> \
 *     --retrieved-at <ISO8601> [--answer-mode claim-as-answer|recover-qa] \
 *     [--holdout-fraction 0.3]
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] ?? '').startsWith('--'));
const [inPath, outPath] = positional;
const retrievedAt = flag('retrieved-at', null);
const answerMode = flag('answer-mode', 'claim-as-answer');
const holdoutFraction = Number(flag('holdout-fraction', '0.3'));

if (!inPath || !outPath || !retrievedAt) {
  console.error('Usage: migrate-to-v1-schema.mjs <in.jsonl> <out.jsonl> --retrieved-at <ISO8601> [--answer-mode ...]');
  process.exit(2);
}
if (!['claim-as-answer', 'recover-qa'].includes(answerMode)) {
  console.error(`Unknown --answer-mode "${answerMode}"`);
  process.exit(2);
}
if (Number.isNaN(Date.parse(retrievedAt))) {
  console.error(`--retrieved-at must be a parseable ISO-8601 timestamp; got "${retrievedAt}"`);
  process.exit(2);
}

/** The instruction HAL is effectively given when it scores a bare claim. */
const VERIFICATION_PROMPT = 'Is the following claim true? Answer TRUE or FALSE.';

const rows = fs
  .readFileSync(inPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`${inPath}:${i + 1} is not valid JSON`);
    }
  });

const dropped = [];
const migrated = [];

for (const [i, r] of rows.entries()) {
  const sourceUrl = r.source_url ?? r.url ?? '';
  // Provenance gate, applied here so the failure is reported per-row with a
  // reason rather than as a wholesale "validation failed" at hash time.
  if (!/^https?:\/\//i.test(String(sourceUrl))) {
    dropped.push({ id: r.row_id ?? r.source_id ?? `row-${i + 1}`, reason: `source_url not absolute http(s): ${JSON.stringify(String(sourceUrl)).slice(0, 60)}` });
    continue;
  }

  const claim = String(r.claim ?? '').trim();
  if (!claim) {
    dropped.push({ id: r.row_id ?? `row-${i + 1}`, reason: 'empty claim' });
    continue;
  }

  let prompt = VERIFICATION_PROMPT;
  let candidateAnswer = claim;
  let construction = r.construction ?? 'claim-verbatim';

  if (answerMode === 'recover-qa') {
    const m = claim.match(/^\s*Q:\s*([\s\S]*?)\s*\bA:\s*([\s\S]*)$/);
    if (m && m[1]?.trim() && m[2]?.trim()) {
      prompt = m[1].trim();
      candidateAnswer = m[2].trim();
      construction = `${construction}+qa-recovered`;
    }
  }

  // Stable id: prefer the corpus's own, else derive from content so re-running
  // is idempotent and the hash does not move because of row order.
  const id = String(r.row_id ?? r.source_id ?? `sha-${crypto.createHash('sha256').update(claim).digest('hex').slice(0, 12)}`);

  const noteParts = [
    r.source ? `source=${r.source}` : null,
    r.source_id ? `source_id=${r.source_id}` : null,
    r.source_title ? `source_title=${r.source_title}` : null,
    r.difficulty ? `difficulty=${r.difficulty}` : null,
    `construction=${construction}`,
    `answer_mode=${answerMode}`,
    'source_retrieved_at is the corpus file commit date, not a per-row retrieval time',
  ].filter(Boolean);

  migrated.push({
    id,
    prompt,
    candidate_answer: candidateAnswer,
    label: String(r.label ?? '').toUpperCase(),
    category: String(r.domain ?? r.category ?? 'uncategorized'),
    source_url: String(sourceUrl),
    source_retrieved_at: retrievedAt,
    notes: noteParts.join('; '),
    split: 'train', // assigned below
  });
}

/**
 * Split assignment.
 *
 * Gate 2 forbids the same prompt+candidate_answer in both splits, so the split
 * is keyed on THAT PAIR's hash, not on the row id — identical content therefore
 * always lands in the same split however many ids it wears. Deterministic, so
 * re-running yields the same partition and the same corpus hash.
 *
 * Stratified by label so a 173/164 balance does not collapse in the holdout.
 */
const byLabel = new Map();
for (const row of migrated) {
  if (!byLabel.has(row.label)) byLabel.set(row.label, []);
  byLabel.get(row.label).push(row);
}
const pairKey = (r) => crypto.createHash('sha256').update(`${r.prompt}\u0000${r.candidate_answer}`).digest('hex');
const splitOf = new Map();
for (const [, group] of byLabel) {
  const ranked = group
    .map((r) => ({ r, k: pairKey(r) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const cut = Math.round(ranked.length * holdoutFraction);
  ranked.forEach(({ r, k }, idx) => {
    const s = splitOf.get(k) ?? (idx < cut ? 'holdout' : 'train');
    splitOf.set(k, s);
    r.split = s;
  });
}

// Duplicate-content report: same pair, multiple rows. Not an error — the schema
// permits it — but it inflates a corpus size that reads as independent evidence.
const seen = new Map();
for (const r of migrated) {
  const k = pairKey(r);
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const dupPairs = [...seen.values()].filter((n) => n > 1).length;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, migrated.map((r) => JSON.stringify(r)).join('\n') + '\n');

const counts = migrated.reduce((a, r) => ((a[`${r.label}/${r.split}`] = (a[`${r.label}/${r.split}`] ?? 0) + 1), a), {});
console.log(`in  : ${inPath} (${rows.length} rows)`);
console.log(`out : ${outPath} (${migrated.length} rows)`);
console.log(`mode: ${answerMode}`);
console.log(`dropped: ${dropped.length}`);
for (const d of dropped) console.log(`   - ${d.id}: ${d.reason}`);
console.log(`duplicate prompt+answer pairs: ${dupPairs}`);
console.log(`label/split: ${JSON.stringify(counts)}`);
