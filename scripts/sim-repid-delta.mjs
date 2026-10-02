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

function firstPassVerdict(value) {
  if (value === 'TRUE') return { verdict: 'TRUE', status: 'counted' };
  if (value === 'FALSE') return { verdict: 'FALSE', status: 'counted' };
  // Literal "y" / "n" and every other non-verdict shape are NOT_CHECKED —
  // never treated as numeric 0 or as a measured pass. Only exact TRUE/FALSE count.
  return { verdict: null, status: 'NOT_CHECKED' };
}

function applyRatings(start, events) {
  let score = start;
  const blockedSubjects = new Set();
  const truePassedSubjects = new Set();
  for (const event of events) {
    if (event.kind === 'first-pass') {
      const fp = firstPassVerdict(event.first_pass_verdict);
      if (fp.verdict === 'TRUE' && event.subject_id) {
        truePassedSubjects.add(event.subject_id);
      } else if (event.subject_id) {
        // FALSE or NOT_CHECKED (missing, null, "null", "undefined", etc.) blocks raises.
        blockedSubjects.add(event.subject_id);
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
  return firstPassVerdict(value);
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

if (!Array.isArray(fixture.null_string_then_true)) fail('null-string first pass fixture missing');
const nullStringPass = fixture.null_string_then_true[0];
if (!nullStringPass || nullStringPass.kind !== 'first-pass') fail('null-string fixture is not a first pass');
if (nullStringPass.first_pass_verdict !== 'null') fail('null-string fixture verdict is not the literal string "null"');
if (nullStringPass.rater_id === nullStringPass.subject_id) fail('null-string first pass is a self rating');
if (!(Number(nullStringPass.delta) > 0)) fail('null-string first pass delta is not positive');
const nullStringLaterPositive = fixture.null_string_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === nullStringPass.subject_id &&
    Number(event.delta) > 0,
);
if (!nullStringLaterPositive) fail('null-string fixture has no later positive rating for the same subject');
const afterNullStringThenTrue = applyRatings(start, fixture.null_string_then_true);
if (afterNullStringThenTrue !== start) fail(`literal "null" first pass followed by TRUE raised the score from ${start} to ${afterNullStringThenTrue}`);
const nullStringReading = readFirstPass(nullStringPass.first_pass_verdict);
if (nullStringReading.status !== 'NOT_CHECKED') fail('literal "null" was not NOT_CHECKED');
if (nullStringReading.verdict === 0) fail('literal "null" was stored as numeric 0');

if (!Array.isArray(fixture.undefined_string_then_true)) fail('undefined-string first pass fixture missing');
const undefinedStringPass = fixture.undefined_string_then_true[0];
if (!undefinedStringPass || undefinedStringPass.kind !== 'first-pass') fail('undefined-string fixture is not a first pass');
if (undefinedStringPass.first_pass_verdict !== 'undefined') fail('undefined-string fixture verdict is not the literal string "undefined"');
if (undefinedStringPass.rater_id === undefinedStringPass.subject_id) fail('undefined-string first pass is a self rating');
if (!(Number(undefinedStringPass.delta) > 0)) fail('undefined-string first pass delta is not positive');
const undefinedStringLaterPositive = fixture.undefined_string_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === undefinedStringPass.subject_id &&
    Number(event.delta) > 0,
);
if (!undefinedStringLaterPositive) fail('undefined-string fixture has no later positive rating for the same subject');
const afterUndefinedStringThenTrue = applyRatings(start, fixture.undefined_string_then_true);
if (afterUndefinedStringThenTrue !== start) fail(`literal "undefined" first pass followed by TRUE raised the score from ${start} to ${afterUndefinedStringThenTrue}`);
const undefinedStringReading = readFirstPass(undefinedStringPass.first_pass_verdict);
if (undefinedStringReading.status !== 'NOT_CHECKED') fail('literal "undefined" was not NOT_CHECKED');
if (undefinedStringReading.verdict === 0) fail('literal "undefined" was stored as numeric 0');

if (!Array.isArray(fixture.other_string_then_true)) fail('other first_pass string fixture missing');
const otherPass = fixture.other_string_then_true[0];
if (!otherPass || otherPass.kind !== 'first-pass') fail('other first_pass string fixture is not a first pass');
if (otherPass.first_pass_verdict === 'TRUE' || otherPass.first_pass_verdict === 'FALSE') {
  fail('other first_pass string fixture is an exact verdict');
}
if (otherPass.rater_id === otherPass.subject_id) fail('other first_pass string is a self rating');
if (!(Number(otherPass.delta) > 0)) fail('other first_pass string delta is not positive');
const otherLaterPositive = fixture.other_string_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === otherPass.subject_id &&
    Number(event.delta) > 0,
);
if (!otherLaterPositive) fail('other first_pass string fixture has no later positive rating');
const afterOtherString = applyRatings(start, fixture.other_string_then_true);
if (afterOtherString !== start) fail(`other first_pass string raised the score from ${start} to ${afterOtherString}`);
const otherReading = readFirstPass(otherPass.first_pass_verdict);
if (otherReading.status !== 'NOT_CHECKED') fail('other first_pass string was counted');
if (otherReading.verdict !== null) fail('other first_pass string stored a verdict');

if (!Array.isArray(fixture.lowercase_y_then_true)) fail('lowercase-y first pass fixture missing');
const lowercaseYPass = fixture.lowercase_y_then_true[0];
if (!lowercaseYPass || lowercaseYPass.kind !== 'first-pass') fail('lowercase-y fixture is not a first pass');
if (lowercaseYPass.first_pass_verdict !== 'y') fail('lowercase-y fixture verdict is not the literal string "y"');
if (lowercaseYPass.rater_id === lowercaseYPass.subject_id) fail('lowercase-y first pass is a self rating');
if (!(Number(lowercaseYPass.delta) > 0)) fail('lowercase-y first pass delta is not positive');
const lowercaseYLaterPositive = fixture.lowercase_y_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === lowercaseYPass.subject_id &&
    Number(event.delta) > 0,
);
if (!lowercaseYLaterPositive) fail('lowercase-y fixture has no later positive rating for the same subject');
const afterLowercaseYThenTrue = applyRatings(start, fixture.lowercase_y_then_true);
if (afterLowercaseYThenTrue !== start) fail(`literal "y" first pass followed by TRUE raised the score from ${start} to ${afterLowercaseYThenTrue}`);
const lowercaseYReading = readFirstPass(lowercaseYPass.first_pass_verdict);
if (lowercaseYReading.status !== 'NOT_CHECKED') fail('literal "y" was not NOT_CHECKED');
if (lowercaseYReading.verdict === 0) fail('literal "y" was stored as numeric 0');

if (!Array.isArray(fixture.lowercase_n_then_true)) fail('lowercase-n first pass fixture missing');
const lowercaseNPass = fixture.lowercase_n_then_true[0];
if (!lowercaseNPass || lowercaseNPass.kind !== 'first-pass') fail('lowercase-n fixture is not a first pass');
if (lowercaseNPass.first_pass_verdict !== 'n') fail('lowercase-n fixture verdict is not the literal string "n"');
if (lowercaseNPass.rater_id === lowercaseNPass.subject_id) fail('lowercase-n first pass is a self rating');
if (!(Number(lowercaseNPass.delta) > 0)) fail('lowercase-n first pass delta is not positive');
const lowercaseNLaterPositive = fixture.lowercase_n_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === lowercaseNPass.subject_id &&
    Number(event.delta) > 0,
);
if (!lowercaseNLaterPositive) fail('lowercase-n fixture has no later positive rating for the same subject');
const afterLowercaseNThenTrue = applyRatings(start, fixture.lowercase_n_then_true);
if (afterLowercaseNThenTrue !== start) fail(`literal "n" first pass followed by TRUE raised the score from ${start} to ${afterLowercaseNThenTrue}`);
const lowercaseNReading = readFirstPass(lowercaseNPass.first_pass_verdict);
if (lowercaseNReading.status !== 'NOT_CHECKED') fail('literal "n" was not NOT_CHECKED');
if (lowercaseNReading.verdict === 0) fail('literal "n" was stored as numeric 0');

if (!Array.isArray(fixture.lowercase_pass_then_true)) fail('lowercase-pass first pass fixture missing');
const lowercasePassPass = fixture.lowercase_pass_then_true[0];
if (!lowercasePassPass || lowercasePassPass.kind !== 'first-pass') fail('lowercase-pass fixture is not a first pass');
if (lowercasePassPass.first_pass_verdict !== 'pass') fail('lowercase-pass fixture verdict is not the literal string "pass"');
if (lowercasePassPass.rater_id === lowercasePassPass.subject_id) fail('lowercase-pass first pass is a self rating');
if (!(Number(lowercasePassPass.delta) > 0)) fail('lowercase-pass first pass delta is not positive');
const lowercasePassLaterPositive = fixture.lowercase_pass_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === lowercasePassPass.subject_id &&
    Number(event.delta) > 0,
);
if (!lowercasePassLaterPositive) fail('lowercase-pass fixture has no later positive rating for the same subject');
const afterLowercasePassThenTrue = applyRatings(start, fixture.lowercase_pass_then_true);
if (afterLowercasePassThenTrue !== start) fail(`literal "pass" first pass followed by TRUE raised the score from ${start} to ${afterLowercasePassThenTrue}`);
const lowercasePassReading = readFirstPass(lowercasePassPass.first_pass_verdict);
if (lowercasePassReading.status !== 'NOT_CHECKED') fail('literal "pass" was not NOT_CHECKED');
if (lowercasePassReading.verdict === 0) fail('literal "pass" was stored as numeric 0');

if (!Array.isArray(fixture.lowercase_fail_then_true)) fail('lowercase-fail first pass fixture missing');
const lowercaseFailPass = fixture.lowercase_fail_then_true[0];
if (!lowercaseFailPass || lowercaseFailPass.kind !== 'first-pass') fail('lowercase-fail fixture is not a first pass');
if (lowercaseFailPass.first_pass_verdict !== 'fail') fail('lowercase-fail fixture verdict is not the literal string "fail"');
if (lowercaseFailPass.rater_id === lowercaseFailPass.subject_id) fail('lowercase-fail first pass is a self rating');
if (!(Number(lowercaseFailPass.delta) > 0)) fail('lowercase-fail first pass delta is not positive');
const lowercaseFailLaterPositive = fixture.lowercase_fail_then_true.find(
  (event, index) =>
    index > 0 &&
    event.kind === 'rating' &&
    event.subject_id === lowercaseFailPass.subject_id &&
    Number(event.delta) > 0,
);
if (!lowercaseFailLaterPositive) fail('lowercase-fail fixture has no later positive rating for the same subject');
const afterLowercaseFailThenTrue = applyRatings(start, fixture.lowercase_fail_then_true);
if (afterLowercaseFailThenTrue !== start) fail(`literal "fail" first pass followed by TRUE raised the score from ${start} to ${afterLowercaseFailThenTrue}`);
const lowercaseFailReading = readFirstPass(lowercaseFailPass.first_pass_verdict);
if (lowercaseFailReading.status !== 'NOT_CHECKED') fail('literal "fail" was not NOT_CHECKED');
if (lowercaseFailReading.verdict === 0) fail('literal "fail" was stored as numeric 0');

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
    `after_null_string_first_pass\t${afterNullStringThenTrue}\n` +
    `null_string_first_pass_status\tNOT_CHECKED\n` +
    `after_undefined_string_first_pass\t${afterUndefinedStringThenTrue}\n` +
    `undefined_string_first_pass_status\tNOT_CHECKED\n` +
    `after_other_first_pass\t${afterOtherString}\n` +
    `other_first_pass_status\tNOT_CHECKED\n` +
    `after_lowercase_y_first_pass\t${afterLowercaseYThenTrue}\n` +
    `lowercase_y_first_pass_status\tNOT_CHECKED\n` +
    `after_lowercase_n_first_pass\t${afterLowercaseNThenTrue}\n` +
    `lowercase_n_first_pass_status\tNOT_CHECKED\n` +
    `after_lowercase_pass_first_pass\t${afterLowercasePassThenTrue}\n` +
    `lowercase_pass_first_pass_status\tNOT_CHECKED\n` +
    `after_lowercase_fail_first_pass\t${afterLowercaseFailThenTrue}\n` +
    `lowercase_fail_first_pass_status\tNOT_CHECKED\n` +
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
