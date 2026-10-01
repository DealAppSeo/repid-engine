import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-repid-arms', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-arms.mjs');
  const fixturePath = path.join(root, 'scripts', 'fixtures', 'repid-aware-arms.json');

  it('prints A bare, B check-this, C later-rater, and live NOT_CHECKED', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      'arm\tA\tbare\n' +
        'arm\tB\tcheck-this\n' +
        'arm\tC\tlater-rater\n' +
        'live_accuracy\tNOT_CHECKED\n',
    );
  });

  it('reads the arm file only and keeps score sentences out of the prompt', () => {
    const src = readFileSync(script, 'utf8');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      arms: { arm: string; prompt: string }[];
    };
    expect(fixture.arms.map((row) => `${row.arm}:${row.prompt}`)).toEqual([
      'A:bare',
      'B:check-this',
      'C:later-rater',
    ]);
    for (const row of fixture.arms) {
      expect(row.prompt.includes('.')).toBe(false);
      expect(/\bscore\b/i.test(row.prompt)).toBe(false);
    }
    expect(src).toContain('repid-aware-arms.json');
    expect(src).not.toContain('hal-traps.json');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).toContain('live_accuracy\\tNOT_CHECKED');
  });
});
