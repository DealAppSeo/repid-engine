/**
 * PORTABILITY FENCE for the demo's Poseidon2 binary lookup.
 *
 * THE BUG THIS PINS. `trust-harness-e2e.mjs` defaulted `LEAF_BIN` to
 * `C:/Users/Cash4/repos/HyperDAG-core/services/babybear-leaf/target/release/leaf.exe`.
 * That path exists on one laptop. Everywhere else the Poseidon2 leg and the progressive
 * fold reported UNKNOWN even when the crate had been built correctly, and the gap blamed
 * a missing primitive rather than a missing username.
 *
 * WHY A TEST AND NOT JUST A FIX. A hard-coded developer path is the kind of thing that
 * grows back — someone debugging locally pastes one in "just for a minute". The
 * `no absolute home-directory path` case below fails when that happens, so time breaks
 * this rather than someone remembering to re-read the file (LESSONS #6).
 *
 * The resolver is pure and injectable, so none of this needs a Rust toolchain, a built
 * binary, or a particular filesystem.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const RESOLVER = path.resolve(__dirname, '../scripts/demo/leaf-bin.mjs').replace(/\\/g, '/');

/**
 * The resolver is ESM; ts-jest compiles this file to CommonJS and jest's VM sandbox
 * refuses a real dynamic `import()` without `--experimental-vm-modules`. Running it in a
 * real Node process keeps the module system honest — the same approach as
 * trust-demo-verify-equivalence.test.ts.
 */
function callResolver(fnBody: string): any {
  const src = `
    import { resolveLeafBin, leafBinCandidates, leafBinaryName, leafBinHelp } from '${RESOLVER}';
    const api = { resolveLeafBin, leafBinCandidates, leafBinaryName, leafBinHelp };
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

const ROOT = '/work/repid-engine';

describe('leaf binary resolution — platform', () => {
  test('picks the right filename per platform', () => {
    const r = callResolver(`({leafBinaryName}) => ({
      win: leafBinaryName('win32'), linux: leafBinaryName('linux'), mac: leafBinaryName('darwin') })`);
    expect(r).toEqual({ win: 'leaf.exe', linux: 'leaf', mac: 'leaf' });
  });
});

describe('leaf binary resolution — precedence', () => {
  test('$LEAF_BIN wins outright (unchanged contract for existing callers)', () => {
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { LEAF_BIN: '/custom/leaf', HYPERDAG_CORE: '/core', PATH: '/usr/bin' },
      platform: 'linux',
      existsFn: () => true,
    })`);
    expect(r.path).toBe('/custom/leaf');
    expect(r.source).toBe('LEAF_BIN');
  });

  test('$HYPERDAG_CORE beats the sibling checkout', () => {
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { HYPERDAG_CORE: '/core', PATH: '' },
      platform: 'linux',
      existsFn: () => true,
    })`);
    expect(r.path).toBe('/core/services/babybear-leaf/target/release/leaf');
    expect(r.source).toBe('HYPERDAG_CORE');
  });

  test('falls back to a sibling HyperDAG-core checkout — the usual layout', () => {
    const sibling = '/work/HyperDAG-core/services/babybear-leaf/target/release/leaf';
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { PATH: '' },
      platform: 'linux',
      existsFn: (p) => p === '${sibling}',
    })`);
    expect(r.path).toBe(sibling);
    expect(r.source).toBe('search');
  });

  test('an explicitly built checkout beats a globally installed leaf on $PATH', () => {
    const sibling = '/work/HyperDAG-core/services/babybear-leaf/target/release/leaf';
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { PATH: '/usr/local/bin' },
      platform: 'linux',
      existsFn: (p) => p === '${sibling}' || p === '/usr/local/bin/leaf',
    })`);
    expect(r.path).toBe(sibling);
  });

  test('finds a lowercased hyperdag-core clone — Linux is case-sensitive and CI runs there', () => {
    const lower = '/work/hyperdag-core/services/babybear-leaf/target/release/leaf';
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { PATH: '' },
      platform: 'linux',
      existsFn: (p) => p === '${lower}',
    })`);
    expect(r.path).toBe(lower);
  });

  test('finds a globally installed leaf when nothing is checked out', () => {
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}',
      env: { PATH: '/opt/bin:/usr/local/bin' },
      platform: 'linux',
      existsFn: (p) => p === '/usr/local/bin/leaf',
    })`);
    expect(r.path).toBe('/usr/local/bin/leaf');
  });
});

describe('leaf binary resolution — failing honestly', () => {
  test('returns null and the list it tried, never a guess', () => {
    const r = callResolver(`({resolveLeafBin}) => resolveLeafBin({
      repoRoot: '${ROOT}', env: { PATH: '/usr/bin' }, platform: 'linux', existsFn: () => false })`);
    expect(r.path).toBeNull();
    expect(r.source).toBeNull();
    expect(r.tried.length).toBeGreaterThan(0);
  });

  test('the help text names the build command, not just the absence', () => {
    const r = callResolver(`({resolveLeafBin, leafBinHelp}) => leafBinHelp(
      resolveLeafBin({ repoRoot: '${ROOT}', env: { PATH: '' }, platform: 'linux', existsFn: () => false }).tried,
      'linux')`);
    expect(r.join('\n')).toMatch(/cargo build --release --bin leaf/);
    expect(r.join('\n')).toMatch(/LEAF_BIN=/);
  });
});

describe("no developer's machine is baked into the demo", () => {
  // This is the regression that matters. A candidate list is allowed to contain paths
  // derived from env vars and the repo root; it must never contain a literal absolute
  // path into somebody's home directory.
  test('no absolute home-directory path among the built-in candidates', () => {
    const cands: string[] = callResolver(`({leafBinCandidates}) => leafBinCandidates({
      repoRoot: '${ROOT}', env: { PATH: '' }, platform: 'win32' })`);
    for (const c of cands) {
      expect(c).not.toMatch(/^[A-Za-z]:[\\/]Users[\\/]/i);
      expect(c).not.toMatch(/^\/(?:home|Users)\//);
    }
    expect(cands.length).toBeGreaterThan(0);
  });

  test('the harness source contains no hard-coded C:/Users path', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    for (const f of ['../scripts/demo/trust-harness-e2e.mjs', '../scripts/demo/leaf-bin.mjs']) {
      const src = readFileSync(path.resolve(__dirname, f), 'utf8');
      // Allowed in a comment explaining the history; never as a live string default.
      const live = src
        .split('\n')
        .filter((l: string) => !/^\s*(\*|\/\/)/.test(l))
        .join('\n');
      expect(live).not.toMatch(/[A-Za-z]:\/Users\//i);
    }
  });
});
