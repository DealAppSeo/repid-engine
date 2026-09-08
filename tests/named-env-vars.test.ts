/**
 * named-env-vars.test.ts — the matcher and the walk cannot go green vacuously.
 *
 * The check script (`scripts/check-named-env-vars.cjs`, `npm run check:named-env-vars`)
 * is the guard. These tests pin the load-bearing pieces a green CLI run could
 * hide: that the walker finds files, that the registry parses, that a phantom
 * token in a comment is detected, and that a constant assignment is not.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-named-env-vars.cjs');

// Plain CommonJS: the check runs with no build step, same as prod-fixture-guard.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../scripts/check-named-env-vars.cjs') as {
  looksLikeEnvVar: (token: string, line: string) => boolean;
  extractComments: (src: string) => string;
  scanText: (
    text: string,
    fileRel: string,
    known: Set<string>,
    allow: Set<string>,
  ) => { token: string; file: string; line: number; excerpt: string }[];
  walkScanTargets: (root?: string) => { md: string[]; ts: string[] };
  loadRegistry: (root?: string) => { ok: boolean; names: Set<string> };
  scanRepo: (root?: string) => { status: string; reason: string | null };
};

describe('looksLikeEnvVar', () => {
  it('flags a backticked phantom named as an env var — the 2026-09-08 shape', () => {
    const line =
      ' * env var `NAMED_ENV_GUARD_PROBE_VAR` invented a money-path gate';
    expect(mod.looksLikeEnvVar('NAMED_ENV_GUARD_PROBE_VAR', line)).toBe(true);
  });

  it('flags process.env.TOKEN and TOKEN=value', () => {
    expect(mod.looksLikeEnvVar('FOO_BAR_BAZ', 'process.env.FOO_BAR_BAZ')).toBe(true);
    expect(mod.looksLikeEnvVar('FOO_BAR_BAZ', "process.env['FOO_BAR_BAZ']")).toBe(true);
    expect(mod.looksLikeEnvVar('FOO_BAR_BAZ', 'FOO_BAR_BAZ=true npm test')).toBe(true);
  });

  it('does not flag a constant assignment with spaces around =', () => {
    expect(mod.looksLikeEnvVar('BFT_THRESHOLD', '- BFT_THRESHOLD = 0.618')).toBe(false);
  });

  it('does not flag a filename stem', () => {
    expect(mod.looksLikeEnvVar('CLAIM_LEDGER', 'see CLAIM_LEDGER.md')).toBe(false);
  });
});

describe('extractComments', () => {
  it('returns line and block comments and ignores strings', () => {
    const src = [
      'const x = "process.env.NOT_A_HIT_IN_STRING";',
      '// env var `PHANTOM_IN_LINE_COMMENT`',
      'const y = 1; /* env var `PHANTOM_IN_BLOCK` */',
    ].join('\n');
    const comments = mod.extractComments(src);
    expect(comments).toContain('PHANTOM_IN_LINE_COMMENT');
    expect(comments).toContain('PHANTOM_IN_BLOCK');
    expect(comments).not.toContain('NOT_A_HIT_IN_STRING');
  });
});

describe('scanText', () => {
  it('names a phantom and ignores a registry name', () => {
    const known = new Set(['X402_ENFORCEMENT_ENABLED']);
    const allow = new Set<string>();
    const text = [
      ' * env var `NAMED_ENV_GUARD_PROBE_VAR`',
      ' * the real gate is `X402_ENFORCEMENT_ENABLED`',
    ].join('\n');
    const hits = mod.scanText(text, 'fake.ts', known, allow);
    expect(hits.map((h) => h.token)).toEqual(['NAMED_ENV_GUARD_PROBE_VAR']);
    expect(hits[0]?.line).toBe(1);
  });
});

describe('walk and registry — refuse a vacuous green', () => {
  it('finds markdown and TypeScript files by walking the tree, not a list', () => {
    const { md, ts } = mod.walkScanTargets(ROOT);
    expect(md.length).toBeGreaterThan(10);
    expect(ts.length).toBeGreaterThan(10);
  });

  it('loads a non-empty generated registry', () => {
    const registry = mod.loadRegistry(ROOT);
    expect(registry.ok).toBe(true);
    expect(registry.names.size).toBeGreaterThan(10);
  });

  it('returns NOT_CHECKED when the registry file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'named-env-'));
    mkdirSync(join(dir, 'src', 'config'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    mkdirSync(join(dir, 'src', 'x'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x', 'a.ts'), '// env var `FOO_BAR_BAZ`\n');
    const result = mod.scanRepo(dir);
    expect(result.status).toBe('NOT_CHECKED');
  });
});

describe('the check script itself', () => {
  it('exits 0 with VERIFIED on this tree after the phantom was removed', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^VERIFIED\b/m);
  });
});
