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
      const reading = readFirstPass(event.first_pass_verdict);
      if (event.subject_id) {
        if (reading.verdict === 'TRUE') {
          truePassedSubjects.add(event.subject_id);
        } else {
          // FALSE and every NOT_CHECKED shape (missing, lowercase "true"/"yes",
          // whitespace, "0", "null", "undefined", "false", "NaN", "Infinity",
          // etc.) block raises. Only exact uppercase TRUE/FALSE are counted.
          blockedSubjects.add(event.subject_id);
        }
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

if (!Array.isArray(fixture.lowercase_true_then_true)) fail('lowercase-true-then-true fixture missing');
const lowercaseTruePass = fixture.lowercase_true_then_true[0];
if (!lowercaseTruePass || lowercaseTruePass.kind !== 'first-pass') fail('lowercase-true-then-true fixture is not a first pass');
if (lowercaseTruePass.first_pass_verdict !== 'true') fail('lowercase-true-then-true fixture is not lowercase true');
if (lowercaseTruePass.rater_id === lowercaseTruePass.subject_id) fail('lowercase-true-then-true first pass is a self rating');
if (!(Number(lowercaseTruePass.delta) > 0)) fail('lowercase-true-then-true first pass delta is not positive');
const laterTrueAfterLowercaseTrue = fixture.lowercase_true_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === lowercaseTruePass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterTrueAfterLowercaseTrue) fail('lowercase-true-then-true fixture has no later positive rating for the same subject');
const afterLowercaseTrueThenTrue = applyRatings(start, fixture.lowercase_true_then_true);
if (afterLowercaseTrueThenTrue !== start) fail(`lowercase "true" first pass followed by TRUE raised the score from ${start} to ${afterLowercaseTrueThenTrue}`);

if (!Array.isArray(fixture.yes_then_true)) fail('yes-then-true fixture missing');
const yesPass = fixture.yes_then_true[0];
if (!yesPass || yesPass.kind !== 'first-pass') fail('yes-then-true fixture is not a first pass');
if (yesPass.first_pass_verdict !== 'yes') fail('yes-then-true fixture is not yes');
if (yesPass.rater_id === yesPass.subject_id) fail('yes-then-true first pass is a self rating');
if (!(Number(yesPass.delta) > 0)) fail('yes-then-true first pass delta is not positive');
const laterTrueAfterYes = fixture.yes_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === yesPass.subject_id &&
    Number(event.delta) > 0,
);
if (!laterTrueAfterYes) fail('yes-then-true fixture has no later positive rating for the same subject');
const afterYesThenTrue = applyRatings(start, fixture.yes_then_true);
if (afterYesThenTrue !== start) fail(`"yes" first pass followed by TRUE raised the score from ${start} to ${afterYesThenTrue}`);

const samples = [
  ...fixture.votes.map((vote) => vote.first_pass_verdict),
  undefined,
  0,
  'NOT_CHECKED',
  'true',
  'yes',
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
    `after_lowercase_true_first_pass\t${afterLowercaseTrueThenTrue}\n` +
    `after_yes_first_pass\t${afterYesThenTrue}\n` +
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
