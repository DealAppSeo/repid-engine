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
    };
    const helpDelta = fixture.nonprofit_help[0]?.delta;
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      `nonprofit_help_score\t${fixture.start_score + Number(helpDelta)}\n` +
        `nonprofit_help_delta\t${helpDelta}\n` +
        `self_rate_zero_score\t${fixture.start_score}\n` +
        `self_rate_zero_delta\t0\n` +
        `first_pass\tNOT_CHECKED\n`,
    );
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
  });
});
