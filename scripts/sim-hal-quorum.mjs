/**
 * Simulate HAL quorum correlated-family votes and compute honest Honesty A counts.
 * Reads the fixture only. Does not insert a row and does not open a network connection.
 * A missing pass, and the number 0, print as NOT_CHECKED.
 *
 * Invariants asserted here:
 *   - NOT_CHECKED is never treated as FALSE.
 *   - first_pass FALSE + post_hal TRUE does not increment the TRUE count.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hal-correlated.json');
const HEADER = ['claim', 'family', 'first_pass', 'post_hal', 'h_post_hal'];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function passCell(verdict) {
  if (verdict === 0 || verdict === '0') return 'NOT_CHECKED';
  if (verdict !== 'TRUE' && verdict !== 'FALSE') return 'NOT_CHECKED';
  return verdict;
}

function emptyCounts() {
  return { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };
}

function addCount(counts, verdict) {
  const cell = passCell(verdict);
  counts[cell] += 1;
}

function honestPostHal(firstPass, postHal) {
  const first = passCell(firstPass);
  const post = passCell(postHal);
  if (first === 'FALSE' && post === 'TRUE') return 'NOT_CHECKED';
  return post;
}

function oneSentence(text) {
  if (typeof text !== 'string') return false;
  const sentence = text.trim();
  return sentence.endsWith('.') && !sentence.slice(0, -1).includes('.');
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const claims = fixture.claims;
if (!Array.isArray(claims) || claims.length < 8) fail(`expected at least 8 claims, got ${claims?.length}`);

const totals = {
  first_pass: emptyCounts(),
  post_hal: emptyCounts(),
};

const lines = [HEADER.join('\t')];

for (const claim of claims) {
  if (typeof claim.id !== 'string' || claim.id.length === 0) fail('claim missing id');
  if (!oneSentence(claim.claim)) fail(`${claim.id} claim is not a single sentence`);
  if (typeof claim.first_pass !== 'object' || claim.first_pass === null) fail(`${claim.id} missing first_pass map`);
  addCount({ TRUE: 0, FALSE: 0, NOT_CHECKED: 0 }, claim.post_hal); // validate post_hal shape

  const families = Object.entries(claim.first_pass);
  if (families.length === 0) fail(`${claim.id} has no families`);

  const computed = {
    first_pass: emptyCounts(),
    post_hal: emptyCounts(),
  };

  for (const [family, verdict] of families) {
    if (typeof family !== 'string' || family.length === 0) fail(`${claim.id} has empty family name`);
    const first = passCell(verdict);
    const post = passCell(claim.post_hal);
    const hPost = honestPostHal(verdict, claim.post_hal);

    lines.push([claim.id, family, first, post, hPost].join('\t'));

    computed.first_pass[first] += 1;
    computed.post_hal[hPost] += 1;
  }

  if (!claim.expected || !claim.expected.first_pass || !claim.expected.post_hal) {
    fail(`${claim.id} missing expected counts`);
  }
  for (const bucket of ['TRUE', 'FALSE', 'NOT_CHECKED']) {
    if (computed.first_pass[bucket] !== claim.expected.first_pass[bucket]) {
      fail(
        `${claim.id} first_pass ${bucket} expected ${claim.expected.first_pass[bucket]} got ${computed.first_pass[bucket]}`,
      );
    }
    if (computed.post_hal[bucket] !== claim.expected.post_hal[bucket]) {
      fail(
        `${claim.id} post_hal ${bucket} expected ${claim.expected.post_hal[bucket]} got ${computed.post_hal[bucket]}`,
      );
    }
    totals.first_pass[bucket] += claim.expected.first_pass[bucket];
    totals.post_hal[bucket] += claim.expected.post_hal[bucket];
  }
}

// Global invariants.
for (const line of lines.slice(1)) {
  const cells = line.split('\t');
  if (cells.length !== HEADER.length) fail('short row');
  for (const cell of cells) {
    if (cell === '0' || cell === '0') fail('printed 0');
  }
  const [, , first, post, hPost] = cells;
  if (first === 'FALSE' && post === 'TRUE' && hPost === 'TRUE') {
    fail('first_pass FALSE + post_hal TRUE incremented TRUE');
  }
}

process.stdout.write(`${lines.join('\n')}\n`);
process.stdout.write(`first_pass_TRUE\t${totals.first_pass.TRUE}\n`);
process.stdout.write(`first_pass_FALSE\t${totals.first_pass.FALSE}\n`);
process.stdout.write(`first_pass_NOT_CHECKED\t${totals.first_pass.NOT_CHECKED}\n`);
process.stdout.write(`post_hal_TRUE\t${totals.post_hal.TRUE}\n`);
process.stdout.write(`post_hal_FALSE\t${totals.post_hal.FALSE}\n`);
process.stdout.write(`post_hal_NOT_CHECKED\t${totals.post_hal.NOT_CHECKED}\n`);
