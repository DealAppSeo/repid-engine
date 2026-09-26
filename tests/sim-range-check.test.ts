import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('sim-range-check', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'sim-range-check.mjs');

  it('verifies the existing fixture and rejects one flipped byte', () => {
    const out = execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
    expect(out).toBe('scheme\tplonky3_range_check\nhonest\tverified\nflipped\trejected\n');
    expect(out).not.toContain('proof_bytes');
  }, 120000);

  it('uses the synthetic fixture and does not add a circuit', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('leaf-rangecheck.synthetic.json');
    expect(src).toContain('plonky3_range_check');
    expect(src).toContain('^ 0x01');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
  });
});
