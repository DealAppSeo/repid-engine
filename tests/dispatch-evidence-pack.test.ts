/**
 * dispatch-evidence-pack.test.ts — the harness reads the code; the codex lane never gets file access.
 *
 * [V 2026-10-14 ~22:15Z] a real codex dispatch on #1377 said "this session exposes no file-reading
 * or repository tools, and you prohibited shell use". buildEvidencePack (scripts/dispatch/run-agent.mjs)
 * builds the diff + full changed files + git log for `--evidence-pack <base>...<head>`, so the agent
 * reviews code it was actually shown. These cases run it against a real throwaway git repo:
 * the pack carries the diff and the files, never .env* or key material, and honours its caps.
 *
 * Same idiom as dispatch-runner-seams.test.ts: the dispatcher is ESM, so each case runs in a real
 * Node process that imports the real module.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER_PATH = path.resolve(__dirname, '../scripts/dispatch/run-agent.mjs');
// A file:// URL, so the import also works on Windows (a bare C:/ path is refused by the ESM loader).
const RUNNER = pathToFileURL(RUNNER_PATH).href;

function call(fnBody: string): any {
  const src = `
    import * as api from '${RUNNER}';
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

/**
 * Calls buildEvidencePack with the cleaner main() uses (exact `scrubValues`, then the shape screen);
 * a throw comes back as { error }. `noClean: true` omits the cleaner, to prove that is refused.
 */
function pack(range: string, opts: Record<string, unknown>): any {
  const { scrubValues = [], noClean = false, ...rest } = opts as { scrubValues?: string[]; noClean?: boolean };
  const clean = noClean ? '' : `, clean: makePromptCleaner(${JSON.stringify(scrubValues)})`;
  return call(`({buildEvidencePack, makePromptCleaner}) => { try { return buildEvidencePack(${JSON.stringify(range)}, { ...${JSON.stringify(rest)}${clean} }); } catch (e) { return { error: String(e.message) }; } }`);
}

const ENV_MARKER = 'marker-from-an-env-file-that-must-never-ship';
const PEM_MARKER = 'marker-from-a-pem-file-that-must-never-ship';

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'evidence-pack-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  git('init', '-q');
  put('src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  put('src/a.ts', 'export const a = 1;\nexport const b = 3; // changed\nexport const c = 4;\n');
  put('tests/x.test.ts', Array.from({ length: 12 }, (_, i) => `// test line ${i + 1}`).join('\n') + '\n');
  put('.env', `PLACEHOLDER=${ENV_MARKER}\n`);
  put('config/.env.production', `PLACEHOLDER=${ENV_MARKER}\n`);
  put('keys/server.pem', `${PEM_MARKER}\n`);
  put('big.md', 'x'.repeat(5000) + '\n');
  put('notes.txt', 'not a source file\n');
  put('config/creds.json', '{"client_secret": "json-marker-never-ships"}\n');
  // -f: a machine-wide gitignore commonly skips .env / *.pem, which would make this fixture vacuous.
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'the change under review');
});

describe('buildEvidencePack — what the codex lane is shown', () => {
  it('carries the git log, the diff, and every changed file in full at head, line-numbered', () => {
    const p = pack('HEAD~1...HEAD', { cwd: repo });
    expect(p.error).toBeUndefined();
    expect(p.range).toBe('HEAD~1...HEAD');
    expect(p.text).toContain('the change under review'); // git log -5
    expect(p.text).toContain('+export const b = 3; // changed'); // the diff
    expect(p.text).toContain('-export const b = 2;');
    expect(p.text).toMatch(/──── src\/a\.ts \(head HEAD, 3 lines\) ────\n {4}1\| export const a = 1;\n {4}2\| export const b = 3; \/\/ changed\n {4}3\| export const c = 4;/);
    expect(p.files).toEqual(expect.arrayContaining([
      { path: 'src/a.ts', status: 'included', lines: 3 },
      { path: 'tests/x.test.ts', status: 'included', lines: 12 },
    ]));
  });

  it('never ships .env* (any depth) or key material: not inlined, not in the diff, listed as excluded', () => {
    const p = pack('HEAD~1...HEAD', { cwd: repo });
    expect(p.text).not.toContain(ENV_MARKER);
    expect(p.text).not.toContain(PEM_MARKER);
    for (const f of ['.env', 'config/.env.production', 'keys/server.pem']) {
      expect(p.files).toContainEqual({ path: f, status: 'excluded (secret-shaped name)' });
    }
  });

  it('respects the per-file cap (truncated, and says so)', () => {
    const p = pack('HEAD~1...HEAD', { cwd: repo, fileMaxChars: 1000 });
    // Its one line was cut, so the agent saw zero whole lines of it.
    expect(p.files).toContainEqual({ path: 'big.md', status: 'included, truncated', lines: 1, shownLines: 0 });
    expect(p.text).toMatch(/\[file TRUNCATED at 1000 chars of \d+\]/);
  });

  it('respects the total cap: what does not fit is LISTED as omitted, never dropped silently', () => {
    const totalMaxChars = 3000;
    const p = pack('HEAD~1...HEAD', { cwd: repo, totalMaxChars });
    const omitted = p.files.filter((f: any) => /^omitted: the pack is at its 3000-char cap$/.test(f.status));
    expect(omitted.map((f: any) => f.path)).toContain('big.md');
    // The inlined parts stay within the cap; only the header/file list sits on top of it.
    const inlined = p.text.split('──── ').slice(1).join('');
    expect(inlined.length).toBeLessThanOrEqual(totalMaxChars);
    expect(p.text).toContain('big.md — omitted');
  });

  it('inlines only source/test/doc files (and package.json / tsconfig*.json); the rest are listed, not shown', () => {
    const p = pack('HEAD~1...HEAD', { cwd: repo });
    expect(p.files).toContainEqual({ path: 'notes.txt', status: 'not inlined (not a source, test or doc file)' });
    expect(p.files).toContainEqual({ path: 'config/creds.json', status: 'not inlined (not a source, test or doc file)' });
    expect(p.text).not.toContain('json-marker-never-ships'); // not inlined, and not in the diff either
    expect(p.text).not.toContain('not a source file');
    const allowed = (f: string) => call(`({packAllowed}) => packAllowed(${JSON.stringify(f)})`);
    for (const f of ['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.md', 'g.sql', 'h.yml', 'i.yaml', 'package.json', 'x/tsconfig.build.json']) {
      expect(allowed(f)).toBe(true);
    }
    for (const f of ['creds.json', 'a.txt', 'key.pem', '.env', 'Dockerfile', 'settings.local.json']) expect(allowed(f)).toBe(false);
  });

  it('is never built without a cleaner', () => {
    expect(pack('HEAD~1...HEAD', { cwd: repo, noClean: true }).error).toMatch(/needs `clean`/);
  });

  it('scrubs BEFORE truncation: a known value cut by the file cap leaves no prefix behind', () => {
    const local = mkdtempSync(path.join(tmpdir(), 'evidence-pack-straddle-'));
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { cwd: local, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(path.join(local, 'a.md'), 'base\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    // "    1| " is 7 chars, so the secret runs from char 47 across the 60-char file cap.
    const secret = 'zq-straddling-secret-value-0001';
    writeFileSync(path.join(local, 'a.md'), 'y'.repeat(40) + secret + 'z'.repeat(40) + '\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'change');
    const p = pack('HEAD~1...HEAD', { cwd: local, fileMaxChars: 60, scrubValues: [secret] });
    expect(p.error).toBeUndefined();
    expect(p.files).toContainEqual(expect.objectContaining({ path: 'a.md', status: 'included, truncated' }));
    expect(p.text).not.toContain(secret.slice(0, 12)); // what a scrub AFTER the cut would have missed
  });

  it.each([
    ['two dots', 'HEAD~1..HEAD'],
    ['an option smuggled as a ref', '--output=/tmp/x...HEAD'],
    ['a shell metacharacter', 'HEAD~1;rm...HEAD'],
    ['an unknown ref', 'no-such-branch...HEAD'],
  ])('refuses a bad range (%s)', (_why, range) => {
    expect(pack(range, { cwd: repo }).error).toBeDefined();
  });
});

describe('auditClaims — a path:line citation into the pack is reading, not running', () => {
  const audit = (input: Record<string, unknown>) => call(`({auditClaims}) => auditClaims(${JSON.stringify(input)})`);
  const CAPS = ['reasoning', 'supplied_evidence'];

  it('grounds a test-file citation the pack can back (file present, line in range)', () => {
    const r = audit({ output: 'The guard is missing at tests/x.test.ts:7.', capabilities: CAPS, evidenceCount: 0, packFiles: { 'tests/x.test.ts': 12 } });
    expect(r.unsupported).toBe(false);
    expect(r.groundedCount).toBe(1);
    expect(r.maxGrade).toBe('R'); // reading supplied code is not execution
  });

  it('still flags a citation past the end of the file, or into a file it was not shown', () => {
    expect(audit({ output: 'see tests/x.test.ts:99', capabilities: CAPS, evidenceCount: 0, packFiles: { 'tests/x.test.ts': 12 } }).unsupported).toBe(true);
    expect(audit({ output: 'see tests/other.test.ts:3', capabilities: CAPS, evidenceCount: 0, packFiles: { 'tests/x.test.ts': 12 } }).unsupported).toBe(true);
  });

  it('a stack frame is never grounded by the pack: only running produces one', () => {
    const r = audit({ output: 'AssertionError\n    at file:///repo/tests/x.test.ts:7:3', capabilities: CAPS, evidenceCount: 0, packFiles: { 'tests/x.test.ts': 12 } });
    expect(r.unsupported).toBe(true);
  });
});

describe('the lane refuses rather than reviewing code it never saw', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [RUNNER_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, TRUSTKEYS_ENV_MASTER: path.join(tmpdir(), 'definitely-not-here', '.env.master') },
    });

  it('requiring supplied_evidence without --evidence-pack is refused (exit 65)', () => {
    const r = run(['--agent', 'codex', '--task', 'review it', '--requires', 'reasoning,supplied_evidence']);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/requires supplied_evidence but no --evidence-pack/);
  });

  it('a bare --evidence-pack with no range is refused (exit 66)', () => {
    const r = run(['--agent', 'codex', '--task', 'review it', '--evidence-pack']);
    expect(r.status).toBe(66);
  });

  it('codex asked for repo_read is refused, and told how to give it the code instead', () => {
    const r = run(['--agent', 'codex', '--task', 'review it', '--requires', 'reasoning,repo_read']);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/CODEX lacks \[repo_read\]/);
    expect(r.stderr).toMatch(/require supplied_evidence and pass --evidence-pack/);
  });
});
