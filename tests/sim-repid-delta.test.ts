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
    expect(src).toContain("rater_role === 'owner'");
    expect(src).toContain('same-family');
    expect(src).toContain('missing_rater\\tNOT_CHECKED');
    expect(src).toContain('counterparty-help');
  });
});
