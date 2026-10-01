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
      counterparty: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
      empty_first_pass: {
        kind: string;
        rater_id: string;
        subject_id: string;
        first_pass_verdict: string;
        delta: number;
      }[];
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
      self_only: { rater_id: string; subject_id: string; delta: number }[];
    };
    const counted = fixture.counterparty[0];
    expect(counted?.kind).toBe('rating');
    expect(counted?.first_pass_verdict).toBe('TRUE');
    expect(counted?.rater_id).not.toBe(counted?.subject_id);
    expect(Number(counted?.delta)).toBeGreaterThan(0);
    const emptyPass = fixture.empty_first_pass[0];
    expect(emptyPass?.kind).toBe('rating');
    expect(emptyPass?.first_pass_verdict).toBe('');
    expect(emptyPass?.rater_id).not.toBe(emptyPass?.subject_id);
    expect(Number(emptyPass?.delta)).toBeGreaterThan(0);
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
        `after_empty_first_pass\t${fixture.start_score}\n` +
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
    expect(src).toContain('empty first pass raised the score');
    expect(src).toContain("event.first_pass_verdict !== 'TRUE'");
    expect(src).toContain('live_accuracy\\tNOT_CHECKED');
    expect(src).toContain("rater_role === 'owner'");
    expect(src).toContain('same-family');
    expect(src).toContain('missing_rater\\tNOT_CHECKED');
    expect(src).toContain('counterparty-help');
  });
});
