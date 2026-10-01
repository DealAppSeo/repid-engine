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
  const blockedSubjects = new Set();
  const truePassedSubjects = new Set();
  for (const event of events) {
    if (event.kind === 'first-pass') {
      if (event.subject_id && event.first_pass_verdict !== 'TRUE') {
        blockedSubjects.add(event.subject_id);
      } else if (event.first_pass_verdict === 'TRUE' && event.subject_id) {
        truePassedSubjects.add(event.subject_id);
      }
      continue;
    }
    if (event.kind !== 'rating' && event.kind !== 'nonprofit-help') continue;
    if (event.rater_id === event.subject_id) continue;
    if (event.rater_role === 'owner') continue;
    if (typeof event.rater_family === 'string' && event.rater_family === event.subject_family) continue;
    if (!presentRater(event.rater_id)) continue;
    if (blockedSubjects.has(event.subject_id)) continue;
    const delta = Number(event.delta);
    if (!Number.isFinite(delta)) continue;
    if (event.hal_decision === 'vetoed' && truePassedSubjects.has(event.subject_id)) {
      // HAL veto after a TRUE first pass is a tax or zero earn, never a raise.
      score -= Math.abs(delta);
      continue;
    }
    if (delta <= 0) continue;
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

if (!Array.isArray(fixture.false_then_true)) fail('false-then-true fixture missing');
const falseThenTruePass = fixture.false_then_true[0];
if (!falseThenTruePass || falseThenTruePass.kind !== 'first-pass') fail('false-then-true fixture is not a first pass');
if (falseThenTruePass.first_pass_verdict !== 'FALSE') fail('false-then-true fixture is not FALSE');
if (falseThenTruePass.rater_id === falseThenTruePass.subject_id) fail('false-then-true first pass is a self rating');
if (!(Number(falseThenTruePass.delta) > 0)) fail('false-then-true first pass delta is not positive');
const laterTrue = fixture.false_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === falseThenTruePass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterTrue) fail('false-then-true fixture has no later positive rating for the same subject');
const afterFalseThenTrue = applyRatings(start, fixture.false_then_true);
if (afterFalseThenTrue !== start) fail(`FALSE first pass followed by TRUE raised the score from ${start} to ${afterFalseThenTrue}`);

if (!Array.isArray(fixture.true_then_hal_veto)) fail('true-then-hal-veto fixture missing');
const trueThenHalPass = fixture.true_then_hal_veto[0];
if (!trueThenHalPass || trueThenHalPass.kind !== 'first-pass') fail('true-then-hal-veto fixture is not a first pass');
if (trueThenHalPass.first_pass_verdict !== 'TRUE') fail('true-then-hal-veto fixture is not TRUE');
if (trueThenHalPass.rater_id === trueThenHalPass.subject_id) fail('true-then-hal-veto first pass is a self rating');
if (!(Number(trueThenHalPass.delta) > 0)) fail('true-then-hal-veto first pass delta is not positive');
const halVeto = fixture.true_then_hal_veto.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === trueThenHalPass.subject_id &&
    event.hal_decision === 'vetoed' &&
    Number(event.delta) > 0,
);
if (!halVeto) fail('true-then-hal-veto fixture has no later HAL veto for the same subject');
const afterTrueThenHalVeto = applyRatings(start, fixture.true_then_hal_veto);
if (afterTrueThenHalVeto > start) fail(`TRUE first pass followed by HAL veto raised the score from ${start} to ${afterTrueThenHalVeto}`);

if (!Array.isArray(fixture.notchecked_then_true)) fail('notchecked-then-true fixture missing');
const notcheckedPass = fixture.notchecked_then_true[0];
if (!notcheckedPass || notcheckedPass.kind !== 'first-pass') fail('notchecked-then-true fixture is not a first pass');
if (notcheckedPass.first_pass_verdict !== undefined && notcheckedPass.first_pass_verdict !== null) {
  fail('notchecked-then-true fixture has an explicit verdict');
}
if (notcheckedPass.rater_id === notcheckedPass.subject_id) fail('notchecked-then-true first pass is a self rating');
if (!(Number(notcheckedPass.delta) > 0)) fail('notchecked-then-true first pass delta is not positive');
const laterPositive = fixture.notchecked_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === notcheckedPass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterPositive) fail('notchecked-then-true fixture has no later positive rating for the same subject');
const afterNotcheckedThenTrue = applyRatings(start, fixture.notchecked_then_true);
if (afterNotcheckedThenTrue !== start) fail(`NOT_CHECKED first pass followed by TRUE raised the score from ${start} to ${afterNotcheckedThenTrue}`);

if (!Array.isArray(fixture.false_literal_then_true)) fail('false-literal first pass fixture missing');
const falseLiteralPass = fixture.false_literal_then_true[0];
if (!falseLiteralPass || falseLiteralPass.kind !== 'first-pass') fail('false-literal first pass fixture is not a first pass');
if (falseLiteralPass.first_pass_verdict !== 'false') fail('false-literal first pass fixture is not the literal string "false"');
if (falseLiteralPass.rater_id === falseLiteralPass.subject_id) fail('false-literal first pass is a self rating');
if (!(Number(falseLiteralPass.delta) > 0)) fail('false-literal first pass delta is not positive');
const laterPositiveAfterFalseLiteral = fixture.false_literal_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === falseLiteralPass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterPositiveAfterFalseLiteral) fail('false-literal first pass fixture has no later positive rating for the same subject');
const afterFalseLiteralFirstPass = applyRatings(start, fixture.false_literal_then_true);
if (afterFalseLiteralFirstPass !== start) fail(`literal "false" first pass raised the score from ${start} to ${afterFalseLiteralFirstPass}`);
const falseLiteralReading = readFirstPass(falseLiteralPass.first_pass_verdict);
if (falseLiteralReading.status !== 'NOT_CHECKED') fail('literal "false" was not NOT_CHECKED');
if (falseLiteralReading.verdict === 0) fail('literal "false" was stored as numeric 0');

if (!Array.isArray(fixture.nan_literal_then_true)) fail('nan-literal first pass fixture missing');
const nanLiteralPass = fixture.nan_literal_then_true[0];
if (!nanLiteralPass || nanLiteralPass.kind !== 'first-pass') fail('nan-literal first pass fixture is not a first pass');
if (nanLiteralPass.first_pass_verdict !== 'NaN') fail('nan-literal first pass fixture is not the literal string "NaN"');
if (nanLiteralPass.rater_id === nanLiteralPass.subject_id) fail('nan-literal first pass is a self rating');
if (!(Number(nanLiteralPass.delta) > 0)) fail('nan-literal first pass delta is not positive');
const laterPositiveAfterNanLiteral = fixture.nan_literal_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === nanLiteralPass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterPositiveAfterNanLiteral) fail('nan-literal first pass fixture has no later positive rating for the same subject');
const afterNanLiteralFirstPass = applyRatings(start, fixture.nan_literal_then_true);
if (afterNanLiteralFirstPass !== start) fail(`literal "NaN" first pass raised the score from ${start} to ${afterNanLiteralFirstPass}`);
const nanLiteralReading = readFirstPass(nanLiteralPass.first_pass_verdict);
if (nanLiteralReading.status !== 'NOT_CHECKED') fail('literal "NaN" was not NOT_CHECKED');
if (nanLiteralReading.verdict === 0) fail('literal "NaN" was stored as numeric 0');

const samples = [
  ...fixture.votes.map((vote) => vote.first_pass_verdict),
  undefined,
  0,
  'NOT_CHECKED',
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
    `after_false_then_true\t${afterFalseThenTrue}\n` +
    `after_true_then_hal_veto\t${afterTrueThenHalVeto}\n` +
    `after_notchecked_first_pass\t${afterNotcheckedThenTrue}\n` +
    `notchecked_first_pass_status\tNOT_CHECKED\n` +
    `after_false_literal_first_pass\t${afterFalseLiteralFirstPass}\n` +
    `false_literal_first_pass_status\tNOT_CHECKED\n` +
    `after_nan_literal_first_pass\t${afterNanLiteralFirstPass}\n` +
    `nan_literal_first_pass_status\tNOT_CHECKED\n` +
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
