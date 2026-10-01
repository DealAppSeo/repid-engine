/**
 * Print first_pass against post_hal for ten local trap claims.
 * Reads the fixture file only. Does not insert a row and does not open a network connection.
 * A missing pass, and the number 0, print as NOT_CHECKED.
 * expected is TRUE or FALSE on the claim sentence.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hal-traps.json');
const TRAPS = ['surgeon', 'missing-dollar', 'birthday', 'ravens', 'monty-underspecified'];
const HEADER = ['trap', 'first_pass', 'post_hal', 'disagree'];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function passCell(verdict) {
  if (verdict === 0 || verdict === '0') return 'NOT_CHECKED';
  if (verdict !== 'TRUE' && verdict !== 'FALSE') return 'NOT_CHECKED';
  return verdict;
}

function oneSentence(text) {
  if (typeof text !== 'string') return false;
  const sentence = text.trim();
  return sentence.endsWith('.') && !sentence.slice(0, -1).includes('.');
}

const checkedZero = passCell(0);
if (checkedZero !== 'NOT_CHECKED' || checkedZero === 0 || checkedZero === '0') {
  fail('missing pass printed 0');
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const claims = fixture.claims;
if (!Array.isArray(claims) || claims.length !== 10) fail(`expected 10 claims, got ${claims?.length}`);

const counts = new Map(TRAPS.map((name) => [name, 0]));
for (const claim of claims) {
  if (!counts.has(claim.trap)) fail(`unexpected trap ${claim.trap}`);
  counts.set(claim.trap, counts.get(claim.trap) + 1);
  if (!oneSentence(claim.claim)) fail(`${claim.id} claim is an essay`);
  if (claim.expected !== 'TRUE' && claim.expected !== 'FALSE') {
    fail(`${claim.id} expected is not TRUE or FALSE`);
  }
  if (JSON.stringify(claim).includes('user_id')) fail('fixture carries a user id');
}
for (const [name, n] of counts) {
  if (n !== 2) fail(`${name} has ${n} claims`);
}

const lines = [HEADER.join('\t')];
for (const claim of claims) {
  const first = passCell(claim.first_pass_verdict);
  const post = passCell(claim.post_hal_verdict);
  for (const cell of [first, post]) {
    if (cell === 0 || cell === '0') fail(`${claim.id} printed 0`);
    if (cell !== 'TRUE' && cell !== 'FALSE' && cell !== 'NOT_CHECKED') fail(`${claim.id} printed ${cell}`);
  }
  const disagree =
    first === 'NOT_CHECKED' || post === 'NOT_CHECKED' ? 'NOT_CHECKED' : first === post ? 'FALSE' : 'TRUE';
  if (disagree === 0 || disagree === '0') fail(`${claim.id} disagree printed 0`);
  lines.push([claim.trap, first, post, disagree].join('\t'));
}

process.stdout.write(`${lines.join('\n')}\n`);
