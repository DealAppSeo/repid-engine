import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim arena', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-arena.mjs');

  it('two agents pick a winner: nonprofit-help +1, self-rate 0', () => {
    const out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(out).toBe(
      'agents\t2\n' +
        'winner\tagent-a\n' +
        'nonprofit_help_delta\t1\n' +
        'self_rate_delta\t0\n',
    );
  });

  it('stays on the fixture and does not send', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('nonprofit-help');
    expect(src).toContain('self-rate');
    expect(src).toContain('delta: 0');
    expect(src).toContain('delta: 1');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('ethers');
    expect(src).not.toContain('sendTransaction');
    expect(src).not.toContain('REAL_STAKING');
  });
});