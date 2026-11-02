/**
 * risk-class.test.ts — the advisory PR weight classifier (scripts/ci/risk-class.cjs).
 *
 * The classifier is only worth having if the weight comes from the PATHS and cannot be
 * argued down. These tests pin the policy table against the REAL rules file, not a copy:
 * a rules edit that moves a path across a class has to change a row here too.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'risk-class.cjs');
const RULES = join(ROOT, 'scripts', 'ci', 'risk-class-rules.json');

type Cls = 'LOW' | 'MEDIUM' | 'MAJOR';
interface FileResult { path: string; class: Cls; reason: string }
interface Result { class: Cls; files: FileResult[]; deciding: FileResult[] }

// Plain CommonJS, same as scripts/check-named-env-vars.cjs: no build step in CI.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rc = require('../scripts/ci/risk-class.cjs') as {
  loadRules: (file: string) => unknown;
  classify: (paths: string[], rules: unknown, opts?: { pkgChanged?: string[] }) => Result;
  pkgFieldsChanged: (base: unknown, head: unknown, fields: string[]) => string[];
  format: (r: Result) => string;
};

const rules = rc.loadRules(RULES);
const classOf = (paths: string[], pkgChanged?: string[]): Cls => rc.classify(paths, rules, { pkgChanged }).class;

function cli(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('risk-class: path sets -> class', () => {
  // [label, changed paths, expected class]
  const table: [string, string[], Cls][] = [
    ['docs only', ['docs/API.md', 'LESSONS.md', 'reports/2026-10-03/x.md', 'reports/hal-eval/_summary.txt'], 'LOW'],
    ['tests only', ['tests/foo.test.ts', 'tests/helpers/offline-prover.ts', 'src/kernel/__tests__/kernel.test.ts'], 'LOW'],
    ['a test that names a MAJOR topic is still only a test', ['tests/x402-gate.test.ts', 'src/services/__tests__/settlement-score-shadow.test.ts'], 'LOW'],
    ['tooling config that ships nothing', ['.gitignore', 'jest.config.js'], 'LOW'],
    ['src/routes change', ['src/routes/health.ts'], 'MEDIUM'],
    ['ordinary service code', ['src/services/mesh-notes.ts'], 'MEDIUM'],
    ['public-claim surface is one level above docs', ['README.md'], 'MEDIUM'],
    ['workflow other than the deploy/release ones', ['.github/workflows/gitleaks.yml'], 'MEDIUM'],
    ['answer-key is not a credential path', ['scripts/answer-key/run.ts', 'src/answer-key/graph.ts'], 'MEDIUM'],
    ['release is not the token "eas"', ['src/routes/release-notes.ts'], 'MEDIUM'],
    ['migration', ['migrations/2026-11-02-add-column.sql'], 'MAJOR'],
    ['supabase migration', ['supabase/migrations/20261102000000_x.sql'], 'MAJOR'],
    ['sql anywhere', ['reports/2026-08-09/unbound-proof-quarantine.sql'], 'MAJOR'],
    ['contract', ['contracts/RepIDStaking.sol'], 'MAJOR'],
    ['grounding file', ['src/hal/hal-grounding.ts'], 'MAJOR'],
    ['scoring file', ['src/scoring/grounding.ts'], 'MAJOR'],
    ['RepID number outside the scoring dir', ['src/services/repid-decay.ts'], 'MAJOR'],
    ['settlement / x402 / erc8004 / eas / stake', ['src/services/x402-gate.ts', 'src/services/settle-passed-contract.ts', 'src/services/erc8004-minter.ts', 'src/services/eas-attestation-service.ts', 'src/routes/stake.ts'], 'MAJOR'],
    ['auth, keys, wallet', ['src/middleware/auth.ts', 'src/services/agent-key-crypto.ts', 'src/services/agent-wallet-manager.ts'], 'MAJOR'],
    ['camelCase token', ['src/utils/agentKey.ts'], 'MAJOR'],
    ['pricing and kernel', ['src/billing/pricing.ts', 'src/kernel/decide.ts'], 'MAJOR'],
    ['Railway / Docker / env', ['railway.toml', 'Dockerfile.fly', 'deploy/README.md', '.env.example'], 'MAJOR'],
    ['deploy and release workflows', ['.github/workflows/deploy.yml', '.github/workflows/release-trust-demo.yml'], 'MAJOR'],
    ['agent permission model', ['.claude/settings.json'], 'MAJOR'],
    ['agent instructions are above docs', ['CLAUDE.md', '.claude/skills/credential-safety/SKILL.md'], 'MEDIUM'],
    ['publishable package manifest', ['packages/trust-demo/package.json'], 'MAJOR'],
    ['case does not hide a path', ['Migrations/x.sql'], 'MAJOR'],
    ['Windows separators do not hide a path', ['src\\scoring\\x.ts'], 'MAJOR'],
  ];
  it.each(table)('%s', (_label, paths, expected) => {
    expect(classOf(paths)).toBe(expected);
  });

  it('an unknown top-level file is not LOW', () => {
    for (const p of ['mystery-file', 'newdir/thing.ts', 'weird.xyz', 'Makefile']) {
      expect(classOf([p])).not.toBe('LOW');
    }
  });

  it('mixed sets: the highest class wins', () => {
    expect(classOf(['docs/API.md', 'tests/a.test.ts'])).toBe('LOW');
    expect(classOf(['docs/API.md', 'src/routes/health.ts'])).toBe('MEDIUM');
    expect(classOf(['docs/API.md', 'src/routes/health.ts', 'migrations/x.sql'])).toBe('MAJOR');
    expect(classOf(['tests/a.test.ts', 'src/scoring/x.ts'])).toBe('MAJOR');
  });

  it('no changed files is LOW and says so', () => {
    const r = rc.classify([], rules);
    expect(r.class).toBe('LOW');
    expect(rc.format(r)).toContain('No changed files.');
  });
});

describe('risk-class: self-protection', () => {
  it.each([
    'scripts/ci/risk-class-rules.json',
    'scripts/ci/risk-class.cjs',
    '.github/workflows/risk-class.yml',
  ])('a change to %s is MAJOR', (p) => {
    expect(classOf([p])).toBe('MAJOR');
    // even when it rides along with a test and a doc, which would otherwise be LOW
    expect(classOf([p, 'tests/a.test.ts', 'docs/API.md'])).toBe('MAJOR');
  });

  it('a renamed-away rules file still lists the old path, so it is still MAJOR', () => {
    // the workflow diffs with --no-renames: the delete of the old path and the add of the new one both appear
    expect(classOf(['scripts/ci/risk-class-rules.json', 'docs/risk-class-rules.md'])).toBe('MAJOR');
  });

  it('rejects a rules file whose default is LOW, so "unknown" can never mean LOW', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-class-'));
    const bad = join(dir, 'rules.json');
    const real = JSON.parse(require('node:fs').readFileSync(RULES, 'utf8'));
    writeFileSync(bad, JSON.stringify({ ...real, defaultClass: 'LOW' }));
    expect(() => rc.loadRules(bad)).toThrow(/never LOW/);
    const r = cli(['--rules', bad, 'x']);
    expect(r.code).toBe(2);
  });
});

describe('risk-class: package.json is classed by which fields changed', () => {
  it('version (release field) changed -> MAJOR and the reason names it', () => {
    const r = rc.classify(['package.json'], rules, { pkgChanged: ['version'] });
    expect(r.class).toBe('MAJOR');
    expect(r.deciding[0]?.reason).toContain('version');
  });
  it('dependency-only change -> MEDIUM', () => {
    expect(classOf(['package.json', 'package-lock.json'], [])).toBe('MEDIUM');
  });
  it('could not compare -> MAJOR (unsure goes up)', () => {
    expect(classOf(['package.json'], undefined)).toBe('MAJOR');
  });
  it('pkgFieldsChanged compares dotted fields', () => {
    const base = { version: '1.0.0', private: true, scripts: { prepublishOnly: 'a', test: 'x' }, dependencies: { a: '1' } };
    const head = { ...base, version: '1.0.1', scripts: { prepublishOnly: 'b', test: 'x' }, dependencies: { a: '2' } };
    expect(rc.pkgFieldsChanged(base, head, ['version', 'private', 'scripts.prepublishOnly'])).toEqual(['version', 'scripts.prepublishOnly']);
    expect(rc.pkgFieldsChanged(base, { ...base, dependencies: { a: '2' } }, ['version', 'private', 'scripts.prepublishOnly'])).toEqual([]);
  });
});

describe('risk-class: CLI output names the deciding file', () => {
  it('lists the file(s) at the winning class and not the lower ones', () => {
    const r = cli(['docs/a.md', 'src/routes/health.ts', 'supabase/migrations/1.sql']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('RISK CLASS: MAJOR');
    expect(r.out).toContain('supabase/migrations/1.sql');
    expect(r.out).toContain('prod schema');
    const decided = r.out.split('Decided by')[1] ?? '';
    expect(decided).not.toContain('docs/a.md');
    expect(decided).not.toContain('src/routes/health.ts');
  });

  it('reads NUL-separated paths from stdin, spaces included (git diff -z)', () => {
    const r = cli([], 'docs/with space.md\0src/routes/health.ts\0');
    expect(r.out).toContain('RISK CLASS: MEDIUM');
    expect(r.out).toContain('src/routes/health.ts');
    expect(r.out).not.toContain('with space');
  });

  it('a changed package.json with no way to compare is MAJOR; --pkg-changed none makes it MEDIUM', () => {
    expect(cli(['package.json']).out).toContain('RISK CLASS: MAJOR');
    expect(cli(['--pkg-changed', 'none', 'package.json']).out).toContain('RISK CLASS: MEDIUM');
    const v = cli(['--pkg-changed', 'version', 'package.json']);
    expect(v.out).toContain('RISK CLASS: MAJOR');
    expect(v.out).toContain('[version]');
  });

  it('caps a long list but still says how many were left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => `migrations/m${i}.sql`);
    const r = cli(many);
    expect(r.out).toContain('... and 5 more at MAJOR');
  });

  it('exits 2 on an unknown option instead of guessing', () => {
    expect(cli(['--nope']).code).toBe(2);
  });
});
