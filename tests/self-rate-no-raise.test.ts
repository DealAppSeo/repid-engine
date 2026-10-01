import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('self-rate-no-raise', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-repid-delta.mjs');

  it('leaves the score unchanged after a positive self-rate following a TRUE first pass or clean HAL', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    const rows = new Map(
      out
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split('\t'))
        .filter((parts) => parts.length === 2) as [string, string][],
    );

    expect(rows.get('after_true_first_pass_self')).toBe('1000');
    expect(rows.get('true_first_pass_self_delta')).toBe('0');
    expect(rows.get('after_clean_hal_self')).toBe('1000');
    expect(rows.get('clean_hal_self_delta')).toBe('0');

    expect(out.toLowerCase()).not.toContain('user_id');
    expect(out.toLowerCase()).not.toContain('claim');
  });
});
