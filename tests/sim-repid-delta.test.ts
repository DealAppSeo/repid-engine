import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-repid-delta', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-delta.mjs');

  it('replays fixture events and prints the score deltas', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as {
      start_score: number;
      nonprofit_help: { delta: number }[];
      false_first_pass: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
      false_then_true: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
      true_then_hal_veto: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        hal_decision?: string;
        delta: number;
      }[];
      notchecked_then_true: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string | null | undefined;
        delta: number;
      }[];
      null_string_then_true: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
      undefined_string_then_true: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
      self_only: { rater_id: string; subject_id: string; delta: number }[];
    };
    const trap = fixture.false_first_pass[0];
    expect(trap?.kind).toBe('first-pass');
    expect(trap?.first_pass_verdict).toBe('FALSE');
    expect(trap?.rater_id).not.toBe(trap?.subject_id);
    expect(Number(trap?.delta)).toBeGreaterThan(0);
    const falseThenTrue = fixture.false_then_true[0];
    expect(falseThenTrue?.kind).toBe('first-pass');
    expect(falseThenTrue?.first_pass_verdict).toBe('FALSE');
    expect(falseThenTrue?.rater_id).not.toBe(falseThenTrue?.subject_id);
    expect(Number(falseThenTrue?.delta)).toBeGreaterThan(0);
    const laterTrue = fixture.false_then_true.find(
      (event, index) =>
        index > 0 &&
        event.kind === 'rating' &&
        event.subject_id === falseThenTrue?.subject_id &&
        Number(event.delta) > 0,
    );
    expect(laterTrue).toBeDefined();
    const trueThenHal = fixture.true_then_hal_veto[0];
    expect(trueThenHal?.kind).toBe('first-pass');
    expect(trueThenHal?.first_pass_verdict).toBe('TRUE');
    expect(trueThenHal?.rater_id).not.toBe(trueThenHal?.subject_id);
    expect(Number(trueThenHal?.delta)).toBeGreaterThan(0);
    const halVeto = fixture.true_then_hal_veto.find(
      (event, index) =>
        index > 0 &&
        event.kind === 'rating' &&
        event.subject_id === trueThenHal?.subject_id &&
        event.hal_decision === 'vetoed' &&
        Number(event.delta) > 0,
    );
    expect(halVeto).toBeDefined();
    const notcheckedThenTrue = fixture.notchecked_then_true[0];
    expect(notcheckedThenTrue?.kind).toBe('first-pass');
    expect(notcheckedThenTrue?.first_pass_verdict).toBeUndefined();
    expect(notcheckedThenTrue?.rater_id).not.toBe(notcheckedThenTrue?.subject_id);
    expect(Number(notcheckedThenTrue?.delta)).toBeGreaterThan(0);
    const laterPositive = fixture.notchecked_then_true.find(
      (event, index) =>
        index > 0 &&
        event.kind === 'rating' &&
        event.subject_id === notcheckedThenTrue?.subject_id &&
        Number(event.delta) > 0,
    );
    expect(laterPositive).toBeDefined();
    const nullStringThenTrue = fixture.null_string_then_true[0];
    expect(nullStringThenTrue?.kind).toBe('first-pass');
    expect(nullStringThenTrue?.first_pass_verdict).toBe('null');
    expect(nullStringThenTrue?.rater_id).not.toBe(nullStringThenTrue?.subject_id);
    expect(Number(nullStringThenTrue?.delta)).toBeGreaterThan(0);
    const nullStringLaterPositive = fixture.null_string_then_true.find(
      (event, index) =>
        index > 0 &&
        event.kind === 'rating' &&
        event.subject_id === nullStringThenTrue?.subject_id &&
        Number(event.delta) > 0,
    );
    expect(nullStringLaterPositive).toBeDefined();
    const undefinedStringThenTrue = fixture.undefined_string_then_true[0];
    expect(undefinedStringThenTrue?.kind).toBe('first-pass');
    expect(undefinedStringThenTrue?.first_pass_verdict).toBe('undefined');
    expect(undefinedStringThenTrue?.rater_id).not.toBe(undefinedStringThenTrue?.subject_id);
    expect(Number(undefinedStringThenTrue?.delta)).toBeGreaterThan(0);
    const undefinedStringLaterPositive = fixture.undefined_string_then_true.find(
      (event, index) =>
        index > 0 &&
        event.kind === 'rating' &&
        event.subject_id === undefinedStringThenTrue?.subject_id &&
        Number(event.delta) > 0,
    );
    expect(undefinedStringLaterPositive).toBeDefined();
    const self = fixture.self_only[0];
    expect(self?.rater_id).toBe(self?.subject_id);
    expect(Number(self?.delta)).toBeGreaterThan(0);
    const helpDelta = fixture.nonprofit_help[0]?.delta;
    expect(helpDelta).toBe(1);
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      `before\t${fixture.start_score}\n` +
        `after_false_first_pass\t${fixture.start_score}\n` +
        `after_false_then_true\t${fixture.start_score}\n` +
        `after_true_then_hal_veto\t${fixture.start_score - Number(halVeto?.delta)}\n` +
        `after_notchecked_first_pass\t${fixture.start_score}\n` +
        `notchecked_first_pass_status\tNOT_CHECKED\n` +
        `after_null_string_first_pass\t${fixture.start_score}\n` +
        `null_string_first_pass_status\tNOT_CHECKED\n` +
        `after_undefined_string_first_pass\t${fixture.start_score}\n` +
        `undefined_string_first_pass_status\tNOT_CHECKED\n` +
        `after_other_first_pass\t${fixture.start_score}\n` +
        `other_first_pass_status\tNOT_CHECKED\n` +
        `after_on_string_first_pass\t${fixture.start_score}\n` +
        `on_string_first_pass_status\tNOT_CHECKED\n` +
        `after_off_string_first_pass\t${fixture.start_score}\n` +
        `off_string_first_pass_status\tNOT_CHECKED\n` +
        `after_counterparty_help\t${fixture.start_score + Number(helpDelta)}\n` +
        `after_self_rating\t${fixture.start_score}\n` +
        `live_accuracy\tNOT_CHECKED\n` +
        `nonprofit_help_score\t${fixture.start_score + Number(helpDelta)}\n` +
        `nonprofit_help_delta\t${helpDelta}\n` +
        `self_rate_zero_score\t${fixture.start_score}\n` +
        `self_rate_zero_delta\t0\n` +
        `first_pass\tNOT_CHECKED\n` +
        `dropped\towner-1\towner-rater\t0\n` +
        `dropped\tagent-c\tsame-family\t0\n` +
        `applied\tagent-r\tcounterparty-help\t1\n` +
        `missing_rater\tNOT_CHECKED\n` +
        `rater_gate_score\t${fixture.start_score + 1}\n` +
        `rater_gate_delta\t1\n`,
    );
    expect(out).not.toContain('missing_rater\t0');
  });

  it('never raises the score after a TRUE first pass followed by a HAL veto', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_true_then_hal_veto\t(\d+)/);
    expect(match).toBeTruthy();
    const score = Number(match?.[1]);
    expect(score).toBeLessThanOrEqual(fixture.start_score);
  });

  it('treats a literal "null" first-pass verdict as NOT_CHECKED and never raises the score', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_null_string_first_pass\t(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(fixture.start_score);
    expect(out).toContain('null_string_first_pass_status\tNOT_CHECKED');
  });

  it('counts only exact TRUE or FALSE and does not raise the score for any other first_pass string', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number; other_string_then_true: { first_pass_verdict: string }[] };
    expect(fixture.other_string_then_true[0]?.first_pass_verdict).toBe('yes');
    expect(fixture.other_string_then_true[0]?.first_pass_verdict).not.toBe('TRUE');
    expect(fixture.other_string_then_true[0]?.first_pass_verdict).not.toBe('FALSE');
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_other_first_pass\t(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(fixture.start_score);
    expect(out).toContain('other_first_pass_status\tNOT_CHECKED');
    expect(out).not.toContain('other_first_pass_status\t0');
  });

  it('treats a literal "undefined" first-pass verdict as NOT_CHECKED and never raises the score', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_undefined_string_first_pass\t(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(fixture.start_score);
    expect(out).toContain('undefined_string_first_pass_status\tNOT_CHECKED');
  });

  it('treats a literal "on" first-pass verdict as NOT_CHECKED and never raises the score', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_on_string_first_pass\t(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(fixture.start_score);
    expect(out).toContain('on_string_first_pass_status\tNOT_CHECKED');
    expect(out).not.toContain('on_string_first_pass_status\t0');
  });

  it('treats a literal "off" first-pass verdict as NOT_CHECKED and never raises the score', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'fixtures', 'repid-delta-events.json'), 'utf8'),
    ) as { start_score: number };
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const match = out.match(/after_off_string_first_pass\t(\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBe(fixture.start_score);
    expect(out).toContain('off_string_first_pass_status\tNOT_CHECKED');
    expect(out).not.toContain('off_string_first_pass_status\t0');
  });

  it('reads the fixture file and does not dial a database', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('repid-delta-events.json');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).toContain("status: 'NOT_CHECKED'");
    expect(src).toContain('rater_id === event.subject_id');
    expect(src).toContain('nonprofit-help');
    expect(src).toContain('self-rate 0 changed the score');
    expect(src).toContain("event.kind === 'first-pass'");
    expect(src).toContain('FALSE first pass raised the score');
    expect(src).toContain('FALSE first pass followed by TRUE raised the score');
    expect(src).toContain('TRUE first pass followed by HAL veto raised the score');
    expect(src).toContain('after_true_then_hal_veto');
    expect(src).toContain('NOT_CHECKED first pass followed by TRUE raised the score');
    expect(src).toContain('live_accuracy\\tNOT_CHECKED');
    expect(src).toContain('notchecked_first_pass_status\\tNOT_CHECKED');
    expect(src).toContain('null_string_first_pass_status\\tNOT_CHECKED');
    expect(src).toContain('undefined_string_first_pass_status\\tNOT_CHECKED');
    expect(src).toContain('literal "null" was stored as numeric 0');
    expect(src).toContain('literal "undefined" was stored as numeric 0');
    expect(src).toContain('literal "on" was stored as numeric 0');
    expect(src).toContain('literal "off" was stored as numeric 0');
    expect(src).toContain("rater_role === 'owner'");
    expect(src).toContain('same-family');
    expect(src).toContain('missing_rater\\tNOT_CHECKED');
    expect(src).toContain('counterparty-help');
  });
});
