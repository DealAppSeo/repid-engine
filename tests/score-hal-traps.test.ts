import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('score-hal-traps', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'score-hal-traps.mjs');
  const printer = path.join(root, 'scripts', 'sim-hal-traps.mjs');

  function disagreementFromPrinter(): number {
    const out = execFileSync(process.execPath, [printer], { cwd: root, encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    let count = 0;
    for (const line of lines.slice(1)) {
      const cell = line.split('\t');
      if (cell[2] !== cell[4]) count += 1;
    }
    return count;
  }

  it('counts first_pass verdicts that differ from post_hal', () => {
    const expected = disagreementFromPrinter();
    expect(expected).toBe(10);
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(`disagreement\t${expected}\n`);
    expect(out).not.toContain('user_id');
    expect(out).not.toContain('\t0\n');
  });

  it('reads the printer stdout and does not insert', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('sim-hal-traps.mjs');
    expect(src).toContain('disagreement');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
