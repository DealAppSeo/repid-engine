import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-repid-delta', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-delta.mjs');

  it('replays fixture events and exits 0', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });

  it('reads the fixture file and does not dial a database', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('repid-delta-events.json');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).toContain("status: 'NOT_CHECKED'");
    expect(src).toContain('rater_id === event.subject_id');
  });
});
