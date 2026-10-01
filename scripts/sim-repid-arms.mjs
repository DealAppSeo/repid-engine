/**
 * Read scripts/fixtures/repid-aware-arms.json only.
 * A is bare, B is check-this, C is later-rater.
 * A prompt has no score sentence. Live accuracy stays NOT_CHECKED.
 * Does not call a vendor.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const armsPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repid-aware-arms.json');
const EXPECTED = [
  ['A', 'bare'],
  ['B', 'check-this'],
  ['C', 'later-rater'],
];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function scoreSentence(text) {
  return typeof text !== 'string' || text.includes('.') || /\bscore\b/i.test(text);
}

const fixture = JSON.parse(readFileSync(armsPath, 'utf8'));
if (!Array.isArray(fixture.arms) || fixture.arms.length !== 3) fail('arm file must have three arms');

const lines = [];
for (let i = 0; i < EXPECTED.length; i += 1) {
  const row = fixture.arms[i];
  const want = EXPECTED[i];
  if (!row || row.arm !== want[0] || row.prompt !== want[1]) fail(`arm ${want[0]} is not ${want[1]}`);
  if (scoreSentence(row.prompt)) fail(`arm ${row.arm} prompt is a score sentence`);
  lines.push(`arm\t${row.arm}\t${row.prompt}`);
}

lines.push('live_accuracy\tNOT_CHECKED');
process.stdout.write(`${lines.join('\n')}\n`);
