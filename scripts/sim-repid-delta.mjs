/**
 * Replay fixture events only. Does not open a database or a network connection.
 * Self-only ratings add nothing. A missing first pass is NOT_CHECKED, not 0.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repid-delta-events.json');

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function applyRatings(start, events) {
  let score = start;
  for (const event of events) {
    if (event.kind !== 'rating') continue;
    if (event.rater_id === event.subject_id) continue;
    const delta = Number(event.delta);
    if (!Number.isFinite(delta) || delta <= 0) continue;
    score += delta;
  }
  return score;
}

function readFirstPass(value) {
  if (value === 'TRUE' || value === 'FALSE') return { verdict: value, status: 'counted' };
  return { verdict: null, status: 'NOT_CHECKED' };
}

const raw = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(raw);
const start = fixture.start_score;

const offered = fixture.self_only.reduce((sum, event) => sum + Number(event.delta), start);
if (!(offered > start)) fail('self-only fixture has no positive rating');
const selfScore = applyRatings(start, fixture.self_only);
if (selfScore !== start) fail(`self-only ratings raised the score from ${start} to ${selfScore}`);
if (selfScore > start) fail('self-only ratings raised the score');

const raised = applyRatings(start, fixture.counterparty);
if (!(raised > start)) fail('a counterparty rating did not raise the score');

const samples = [
  ...fixture.votes.map((vote) => vote.first_pass_verdict),
  undefined,
  0,
];
for (const value of samples) {
  const reading = readFirstPass(value);
  if (reading.status !== 'NOT_CHECKED') fail(`first_pass ${JSON.stringify(value)} was ${reading.status}`);
  if (reading.verdict !== null) fail(`first_pass ${JSON.stringify(value)} stored ${reading.verdict}`);
  if (reading.verdict === 0) fail('first_pass missing was stored as 0');
}

process.stdout.write('ok\n');
