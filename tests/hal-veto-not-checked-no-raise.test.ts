import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('hal-veto-not-checked-no-raise', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-delta.mjs');

  it('keeps the start score when a HAL-vetoed positive rating follows a NOT_CHECKED/missing first pass', () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    const rows = new Map(
      stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split('\t'))
        .filter((parts) => parts.length === 2) as [string, string][],
    );

    expect(rows.get('after_notchecked_hal_veto')).toBe('1000');
    expect(rows.get('notchecked_first_pass_status')).toBe('NOT_CHECKED');

    const combined = (stdout + stderr).toLowerCase();
    expect(combined).not.toContain('user_id');
    expect(combined).not.toContain('claim');
  });
});
