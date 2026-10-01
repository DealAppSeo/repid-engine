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

function presentRater(id) {
  return id !== undefined && id !== null && id !== '' && id !== 0 && id !== '0';
}

function applyRatings(start, events) {
  let score = start;
  for (const event of events) {
    if (event.kind === 'first-pass') continue;
    if (event.kind !== 'rating' && event.kind !== 'nonprofit-help') continue;
    if (event.rater_id === event.subject_id) continue;
    if (event.rater_role === 'owner') continue;
    if (typeof event.rater_family === 'string' && event.rater_family === event.subject_family) continue;
    if (!presentRater(event.rater_id)) continue;
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

if (!Array.isArray(fixture.nonprofit_help)) fail('nonprofit-help fixture missing');
const helped = applyRatings(start, fixture.nonprofit_help);
if (helped !== start + 1) fail(`nonprofit-help moved the score by ${helped - start}`);

if (!Array.isArray(fixture.self_rate_zero)) fail('self-rate fixture missing');
const zeroSelf = fixture.self_rate_zero.some(
  (event) => event.rater_id === event.subject_id && Number(event.delta) === 0,
);
if (!zeroSelf) fail('self-rate fixture is not a zero self rating');
const zeroScore = applyRatings(start, fixture.self_rate_zero);
if (zeroScore !== start) fail('self-rate 0 changed the score');

if (!Array.isArray(fixture.false_first_pass)) fail('false first pass fixture missing');
const falsePass = fixture.false_first_pass[0];
if (!falsePass || falsePass.kind !== 'first-pass') fail('false first pass fixture is not a first pass');
if (falsePass.first_pass_verdict !== 'FALSE') fail('false first pass fixture is not FALSE');
if (falsePass.rater_id === falsePass.subject_id) fail('false first pass is a self rating');
if (!(Number(falsePass.delta) > 0)) fail('false first pass delta is not positive');
const afterFalse = applyRatings(start, fixture.false_first_pass);
if (afterFalse !== start) fail(`FALSE first pass raised the score from ${start} to ${afterFalse}`);

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

if (presentRater(0) || presentRater('0')) fail('missing rater stored as 0');
if (!Array.isArray(fixture.rater_gate)) fail('rater gate fixture missing');
const dropLines = [];
let appliedHelp = 0;
for (const event of fixture.rater_gate) {
  if (!presentRater(event.rater_id)) {
    dropLines.push('missing_rater\tNOT_CHECKED');
    continue;
  }
  if (event.rater_role === 'owner') {
    dropLines.push(`dropped\t${event.rater_id}\towner-rater\t0`);
    continue;
  }
  if (typeof event.rater_family === 'string' && event.rater_family === event.subject_family) {
    dropLines.push(`dropped\t${event.rater_id}\tsame-family\t0`);
    continue;
  }
  if (event.kind === 'nonprofit-help' && event.rater_id !== event.subject_id) {
    appliedHelp += Number(event.delta);
    dropLines.push(`applied\t${event.rater_id}\tcounterparty-help\t${event.delta}`);
  }
}
if (appliedHelp !== 1) fail(`counterparty help applied ${appliedHelp}`);
const gated = applyRatings(start, fixture.rater_gate);
if (gated !== start + 1) fail(`rater gate moved the score by ${gated - start}`);

process.stdout.write(
  `before\t${start}\n` +
    `after_false_first_pass\t${afterFalse}\n` +
    `after_counterparty_help\t${helped}\n` +
    `after_self_rating\t${selfScore}\n` +
    `live_accuracy\tNOT_CHECKED\n` +
    `nonprofit_help_score\t${helped}\n` +
    `nonprofit_help_delta\t${helped - start}\n` +
    `self_rate_zero_score\t${zeroScore}\n` +
    `self_rate_zero_delta\t${zeroScore - start}\n` +
    `first_pass\tNOT_CHECKED\n` +
    `${dropLines.join('\n')}\n` +
    `rater_gate_score\t${gated}\n` +
    `rater_gate_delta\t${gated - start}\n`,
);
