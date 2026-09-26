/**
 * Print first_pass against post_hal for ten local trap claims.
 * Reads the fixture file only. Does not insert a row and does not open a network connection.
 * A missing pass, and the number 0, print as NOT_CHECKED.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hal-traps.json');
const TRAPS = ['surgeon', 'missing-dollar', 'birthday', 'ravens', 'monty-underspecified'];
const HEADER = [
  'trap',
  'id',
  'first_pass_verdict',
  'first_pass_at',
  'post_hal_verdict',
  'post_hal_at',
];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function passCell(verdict, at) {
  if (verdict === 0 || verdict === '0') {
    return { verdict: 'NOT_CHECKED', at: 'NOT_CHECKED' };
  }
  if (verdict !== 'TRUE' && verdict !== 'FALSE') {
    return { verdict: 'NOT_CHECKED', at: 'NOT_CHECKED' };
  }
  const stamp = typeof at === 'string' && at.length > 0 ? at : 'NOT_CHECKED';
  return { verdict, at: stamp };
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const claims = fixture.claims;
if (!Array.isArray(claims) || claims.length !== 10) fail(`expected 10 claims, got ${claims?.length}`);

const counts = new Map(TRAPS.map((name) => [name, 0]));
for (const claim of claims) {
  if (!counts.has(claim.trap)) fail(`unexpected trap ${claim.trap}`);
  counts.set(claim.trap, counts.get(claim.trap) + 1);
  if (JSON.stringify(claim).includes('user_id')) fail('fixture carries a user id');
}
for (const [name, n] of counts) {
  if (n !== 2) fail(`${name} has ${n} claims`);
}

const sawZero = claims.some((claim) => claim.first_pass_verdict === 0 || claim.post_hal_verdict === 0);
const sawMissingFirst = claims.some((claim) => !Object.prototype.hasOwnProperty.call(claim, 'first_pass_verdict'));
const sawMissingPost = claims.some((claim) => !Object.prototype.hasOwnProperty.call(claim, 'post_hal_verdict'));
if (!sawZero) fail('fixture has no numeric 0 pass');
if (!sawMissingFirst || !sawMissingPost) fail('fixture is missing a pass field');

const lines = [HEADER.join('\t')];
for (const claim of claims) {
  const first = passCell(claim.first_pass_verdict, claim.first_pass_at);
  const post = passCell(claim.post_hal_verdict, claim.post_hal_at);
  for (const cell of [first, post]) {
    if (cell.verdict === 0 || cell.verdict === '0' || cell.at === 0 || cell.at === '0') {
      fail(`${claim.id} printed 0`);
    }
    if (cell.verdict !== 'TRUE' && cell.verdict !== 'FALSE' && cell.verdict !== 'NOT_CHECKED') {
      fail(`${claim.id} printed ${cell.verdict}`);
    }
  }
  lines.push([claim.trap, claim.id, first.verdict, first.at, post.verdict, post.at].join('\t'));
}

process.stdout.write(`${lines.join('\n')}\n`);
