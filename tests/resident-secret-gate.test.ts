/**
 * The resident-secret ratchet.
 *
 * The gate it replaces reported green while a live Supabase service_role key for
 * Trinity production sat in a tracked file, because it scanned commit RANGES and the
 * key was resident. These tests pin the two properties that make the replacement
 * meaningful: an unknown file always fails, and the baseline can only shrink.
 */

// The gate is deliberately plain CommonJS Node so CI can run it with no TypeScript
// step — a secret gate that needs a build to run is a gate that gets skipped.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { evaluateScan, normalisePath } = require('../scripts/ci/resident-secret-gate.js');

type Finding = { File: string };
const at = (file: string, n = 1): Finding[] => Array.from({ length: n }, () => ({ File: file }));

const BASE = { 'tests/known-noisy.test.ts': 2, 'src/services/fixture.ts': 1 };

describe('path normalisation', () => {
  it('reduces an absolute posix path to repo-relative', () => {
    expect(normalisePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('leaves an already-relative path alone', () => {
    expect(normalisePath('src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('strips a leading ./', () => {
    expect(normalisePath('./src/a.ts', '/repo')).toBe('src/a.ts');
  });
});

describe('THE GATE: a finding in an unbaselined file always fails', () => {
  it('fails on a brand-new leaking file', () => {
    const r = evaluateScan(at('service_role.txt'), BASE, '/repo');
    expect(r.pass).toBe(false);
    expect(r.unknownFiles).toEqual(['service_role.txt']);
  });

  it('fails even when the total count went DOWN', () => {
    // The exact hole a bare count tripwire would leave: clear two known findings,
    // add one real secret, total falls, and a count-only gate reports success.
    const r = evaluateScan(at('.claude/settings.local.json'), BASE, '/repo');
    expect(r.total).toBeLessThan(r.baseTotal);
    expect(r.pass).toBe(false);
  });
});

describe('known-noisy files', () => {
  it('passes at exactly the baseline count', () => {
    const r = evaluateScan([...at('tests/known-noisy.test.ts', 2), ...at('src/services/fixture.ts', 1)], BASE, '/repo');
    expect(r.pass).toBe(true);
  });

  it('fails when a known file gains a finding, and says what changed', () => {
    const r = evaluateScan(at('tests/known-noisy.test.ts', 3), BASE, '/repo');
    expect(r.pass).toBe(false);
    expect(r.grownFiles).toEqual([{ file: 'tests/known-noisy.test.ts', was: 2, now: 3 }]);
  });

  it('passes when a known file loses findings, and reports the tightening', () => {
    const r = evaluateScan(at('tests/known-noisy.test.ts', 1), BASE, '/repo');
    expect(r.pass).toBe(true);
    expect(r.cleared).toEqual(
      expect.arrayContaining([{ file: 'src/services/fixture.ts', was: 1, now: 0 }]),
    );
  });

  it('an empty scan passes and reports every entry as cleared', () => {
    const r = evaluateScan([], BASE, '/repo');
    expect(r.pass).toBe(true);
    expect(r.cleared).toHaveLength(2);
  });
});

describe('the real baseline shipped with this repo', () => {
  it('is internally consistent — the module total matches its own table', () => {
    // Guards against someone editing one entry and not the sum.
    const r = evaluateScan([], undefined, '/repo');
    expect(r.baseTotal).toBeGreaterThan(0);
    expect(r.total).toBe(0);
    expect(r.pass).toBe(true);
  });
});
