/**
 * dispatch-codex-tools-off.test.ts — the codex lane holds no tool, and nothing secret reaches its prompt.
 *
 * XC1 on #1380: `codex exec -s read-only` is a sandbox for model-run commands, not their absence, and
 * read-only still reads the whole disk. The evidence pack carries PR diffs (attacker-controllable text
 * on a public repo), so a prompt injection could have codex read `.env.master` into OpenAI's context
 * before any scrubber ran. These cases pin the fix:
 *   1. every codex tool feature is disabled by flag, and a lane or version no canary has passed is
 *      refused (exit 67); a tool event in the output voids the run;
 *   2. the pack inlines only source/test/doc files and screens content by shape, after an exact-value
 *      scrub that runs BEFORE truncation;
 *   3. --evidence output gets the same treatment;
 *   4. tested by what a fake codex actually RECEIVES on stdin, not by grepping the dispatcher;
 *   5. a path:line citation is grounded only within the lines the agent was shown.
 * The live proof that the flags turn the tools off is tests/dispatch-codex-canary.test.ts (opt-in).
 * Nothing here reaches OpenAI: the `codex` on PATH is a fake that records its stdin.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER_PATH = path.resolve(__dirname, '../scripts/dispatch/run-agent.mjs');
const RUNNER = pathToFileURL(RUNNER_PATH).href;

function call(fnBody: string): any {
  const src = `
    import * as api from '${RUNNER}';
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

describe('1. codex runs only with every tool off, on a version a canary has passed', () => {
  const FEATURES: string[] = call(`({CODEX_DISABLED_FEATURES}) => CODEX_DISABLED_FEATURES`);
  const argv = (agent: string) =>
    call(`({AGENTS}) => AGENTS[${JSON.stringify(agent)}].args('<p>', { root: 'C:/wt', env: { CODEX_OSS_MODEL: 'gpt-oss:20b' } })`) as string[];
  const refusal = (agent: string, a: string[], version: string) =>
    call(`({codexToolsRefusal}) => codexToolsRefusal(${JSON.stringify(agent)}, ${JSON.stringify(a)}, ${JSON.stringify(version)})`);

  it('the lane argv disables code mode, the shell and every other tool-carrying feature', () => {
    expect(FEATURES).toEqual(expect.arrayContaining(['code_mode_host', 'shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'multi_agent']));
    const a = argv('codex');
    for (const f of FEATURES) expect(a[a.indexOf(f) - 1]).toBe('--disable');
    expect(refusal('codex', a, 'codex-cli 0.162.1')).toBeNull();
  });

  it('refuses an argv that leaves any one feature on', () => {
    const a = argv('codex');
    for (const f of FEATURES) {
      const i = a.indexOf(f);
      const without = [...a.slice(0, i - 1), ...a.slice(i + 1)];
      expect(refusal('codex', without, 'codex-cli 0.162.1')).toMatch(new RegExp(`leaves ${f} enabled`));
    }
  });

  it('refuses a codex version the canary has not passed, or one it cannot read', () => {
    expect(refusal('codex', argv('codex'), 'codex-cli 0.163.0')).toMatch(/0\.163\.0 has not passed the canary/);
    expect(refusal('codex', argv('codex'), '')).toMatch(/could not read the codex version/);
  });

  it('refuses codex-oss: no canary has run against the --oss provider', () => {
    expect(refusal('codex-oss', argv('codex-oss'), 'codex-cli 0.162.1')).toMatch(/no canary has shown command execution off for the codex-oss lane/);
  });

  it('leaves non-codex lanes alone', () => {
    expect(refusal('xc', ['-p', 'x'], '')).toBeNull();
  });

  it('a tool event in codex output is reported, so main() can void the run', () => {
    const ev = (o: unknown) => JSON.stringify(o);
    const parse = (lines: string[]) => call(`({parseCodexJsonl}) => parseCodexJsonl(${JSON.stringify(lines.join('\n'))})`);
    const clean = parse([
      ev({ type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } }),
      ev({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } }),
      ev({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL [R]' } }),
    ]);
    expect(clean.toolUse).toEqual([]);
    const used = parse([
      ev({ type: 'item.started', item: { type: 'command_execution', command: 'cat .env.master' } }),
      ev({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'read_mcp_resource' } }),
      ev({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL [R]' } }),
    ]);
    expect(used.toolUse).toEqual(['command_execution', 'mcp_tool_call']);
  });
});

describe('2. screenSecrets catches the shape of a secret nobody listed', () => {
  const screen = (s: string) => call(`({screenSecrets}) => screenSecrets(${JSON.stringify(s)})`);
  // Assembled at runtime so this file holds no secret-shaped literal for a scanner to flag.
  const j = (...parts: string[]) => parts.join('');
  const hex64 = 'ab'.repeat(32);

  it.each([
    ['a PEM header', j('-----BEGIN', ' OPENSSH PRIVATE KEY-----'), 'pem'],
    ['a shell export', j('export OPENAI', '_API_KEY=whatever'), 'export-assignment'],
    ['a lowercase key=', j('curl https://x.example/v1?ke', 'y=AbCdEf123456'), 'credential-assignment'],
    ['an env-file line', j('SUPABASE_SERVICE_KE', 'Y=abcdef123456'), 'credential-assignment'],
    ['an OpenAI key', j("const k = 'sk-", "proj-abcdefghijklmnopqrstu';"), 'key-prefix'],
    ['an xAI key', j('xai-', 'abcdefghijklmnopqrstuv'), 'key-prefix'],
    ['a GitHub token', j('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'), 'key-prefix'],
    ['a fine-grained PAT', j('github', '_pat_', '11ABCDEFG0123456789_abcdefghij'), 'key-prefix'],
    ['a Supabase server key', j('sb_', 'sec', 'ret_', 'abcdefgh', 'ijklmnop1234'), 'key-prefix'],
    ['an AWS access key id', j('AK', 'IA', 'IOSFODNN7EXAMPLE'), 'key-prefix'],
    ['a JWT', j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0.sig'), 'key-prefix'],
    ['a 64-hex private key', `0x${hex64}`, 'hex-32+'],
    ['a base64 key', j('value: q7Kd9VbR2m', 'XzP4tLw8Yc', 'N3hG6sJfA1', 'eUoZiT5yBn'), 'high-entropy'],
  ])('%s', (_name, line, why) => {
    expect(screen(line)).toEqual({ text: `<line screened: ${why}>`, screened: 1 });
  });

  it.each([
    ['an EVM address (public, needed in review)', 'const REG = 0x8004A818BFB912233c491871b3d84c89A494BD9e;'],
    ['a TS export', 'export const x = 1;'],
    ['a key variable with spaces', 'const cacheKey = computeKey(x);'],
    ['a short dated path', 'see reports/2026-10-14/NOTES.md'],
    ['a long identifier', 'CODEX_DISABLED_FEATURES_FOR_THE_LANE'],
    ['a 40-hex git sha', 'cherry-pick 04f77e8392b6c046d47cee5bc48ba1e6f3040bdf'],
  ])('leaves %s alone', (_name, line) => {
    expect(screen(line)).toEqual({ text: line, screened: 0 });
  });
  // Known false positives, measured 2026-10-15 over src/, tests/ and scripts/: 181 of 363,913 lines
  // (0.05%), mostly 64-hex tx hashes (indistinguishable from a private key) and long dated report
  // paths. A screened line costs a reviewer one line; a missed key costs the key.
});

// ---------------------------------------------------------------------------------------------------
// End to end: the real main(), a fake `codex` that records what it was sent.
// ---------------------------------------------------------------------------------------------------
// Assembled at runtime, like the table above, so the file itself carries no secret-shaped literal.
const INVENTORY_SECRET = ['inv', 'secret-value-abcdef123456'].join('-');
const OPENAI_FAKE = ['sk', 'fake-openai-key-for-tests-0001'].join('-');
const AWS_KEY = ['AK', 'IA', 'ZZZZZZZZZZZZZZZZ'].join('');
const PEM_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7'].join('');
const DATA_MARKER = 'marker-in-a-non-allowlisted-file';

let repo: string;
let fakeBin: string;
let envMaster: string;
let PATH: string;

function writeFakeCodex(version: string) {
  writeFileSync(
    path.join(fakeBin, 'fake-codex.mjs'),
    [
      "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `if (process.argv.includes('--version')) { process.stdout.write('codex-cli ${version}\\n'); process.exit(0); }`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; }).on('end', () => {",
      '  const home = process.env.CODEX_HOME;',
      "  writeFileSync(join(home, 'prompt.txt'), input);",
      "  writeFileSync(join(home, 'argv.json'), JSON.stringify(process.argv.slice(2)));",
      "  const reply = existsSync(join(home, 'reply.txt')) ? readFileSync(join(home, 'reply.txt'), 'utf8') : 'FINAL: reviewed [R]';",
      "  const extra = existsSync(join(home, 'events.jsonl')) ? readFileSync(join(home, 'events.jsonl'), 'utf8') : '';",
      "  process.stdout.write(extra + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }) + '\\n');",
      '});',
    ].join('\n'),
  );
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-tools-off-'));
  repo = path.join(root, 'repo');
  fakeBin = path.join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(fakeBin);

  envMaster = path.join(root, '.env.master');
  writeFileSync(envMaster, `OPENAI_API_KEY=${OPENAI_FAKE}\nSOME_OTHER_SECRET=${INVENTORY_SECRET}\n`);

  writeFakeCodex('0.162.1');
  writeFileSync(path.join(fakeBin, 'codex.cmd'), `@"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
  writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.mjs" "$@"\n`);
  chmodSync(path.join(fakeBin, 'codex'), 0o755);

  // A PATH with the fake first and nothing else that could resolve `codex`.
  if (process.platform === 'win32') {
    const git = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
    PATH = [fakeBin, path.dirname(process.execPath), path.dirname(git), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
  } else {
    PATH = [fakeBin, process.env.PATH].join(path.delimiter);
  }

  // A throwaway fixture repo of deliberately secret-shaped FAKES that is never pushed. An operator-wide
  // pre-commit secret scanner (core.hooksPath) refuses these commits, which is its job on a real repo
  // and no property of the code under test, so this one repo gets an empty hooks directory.
  const hooks = path.join(root, 'no-hooks');
  mkdirSync(hooks);
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', `core.hooksPath=${hooks}`, ...a], { cwd: repo, encoding: 'utf8' });
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  git('init', '-q');
  git('checkout', '-q', '-b', 'base-branch');
  put('src/clean.ts', 'export const a = 1;\n');
  put('.gitignore', 'reports/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  put('src/clean.ts', 'export const a = 1;\nexport const visibleMarker = "the-pack-was-inlined";\n');
  put('src/leak.ts', `export const s = '${INVENTORY_SECRET}';\nexport const aws = '${AWS_KEY}';\n`);
  // A key file renamed into an allowed name: caught by content, not by name.
  put('docs/notes.md', `# notes\n${PEM_HEADER}\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`);
  put('data.txt', `${DATA_MARKER}\n`);
  // 2,000 lines, about 54 chars each once numbered: the 40,000-char file cap cuts it near line 740.
  put('tests/big.test.ts', Array.from({ length: 2000 }, (_, i) => `// line ${i + 1} ${'x'.repeat(36)}`).join('\n') + '\n');
  put('print.mjs', `console.log('evidence says hello');\nconsole.log('${INVENTORY_SECRET} ${AWS_KEY}');\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'the change under review');
});

// Windows: `where` needs PATHEXT to find codex.cmd, and cmd.exe needs SystemRoot / ComSpec.
const WIN_ESSENTIALS: Record<string, string> = Object.fromEntries(
  ['SystemRoot', 'PATHEXT', 'ComSpec'].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);

function dispatch(agent: string, extra: string[] = [], setup: (home: string) => void = () => {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  setup(home);
  const env: Record<string, string> = {
    PATH,
    TRUSTKEYS_ENV_MASTER: envMaster,
    CODEX_HOME: home,
    TEMP: tmpdir(),
    TMP: tmpdir(),
    ...WIN_ESSENTIALS,
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
  const r = spawnSync(
    process.execPath,
    [RUNNER_PATH, '--agent', agent, '--task', 'Review the change.', '--requires', 'reasoning,supplied_evidence',
      '--evidence-pack', 'base-branch...feature', ...extra],
    { cwd: repo, encoding: 'utf8', env, timeout: 120_000 },
  );
  const read = (f: string) => (existsSync(path.join(home, f)) ? readFileSync(path.join(home, f), 'utf8') : null);
  return { ...r, prompt: read('prompt.txt'), argv: read('argv.json') };
}

describe('end to end: what the fake codex receives', () => {
  it('2/3/4. the pack and the evidence reach codex cleaned: no inventory value, no key shape, no non-allowlisted file', () => {
    const r = dispatch('codex', ['--evidence', 'node print.mjs']);
    expect(r.stderr).not.toMatch(/REFUSED/);
    expect(r.status).toBe(0);
    const p = r.prompt!;
    expect(p).toContain('the-pack-was-inlined'); // non-vacuity: the pack really is in the prompt
    expect(p).toContain('evidence says'); // and so is the evidence
    expect(p).not.toContain(INVENTORY_SECRET);
    expect(p).not.toContain(OPENAI_FAKE);
    expect(p).not.toContain(AWS_KEY);
    expect(p).not.toContain('-----BEGIN');
    expect(p).not.toContain(PEM_BODY);
    expect(p).not.toContain(DATA_MARKER);
    expect(p).toContain('<redacted>');
    expect(p).toContain('<line screened: ');
    expect(p).toMatch(/data\.txt — not inlined \(not a source, test or doc file\)/);
    // and codex was launched with every tool off
    const argv = JSON.parse(r.argv!);
    for (const f of call(`({CODEX_DISABLED_FEATURES}) => CODEX_DISABLED_FEATURES`) as string[]) expect(argv).toContain(f);
  }, 120_000);

  it('5. a citation past what the truncated file showed is UNSUPPORTED; one inside it is not', () => {
    const past = dispatch('codex', [], (home) => writeFileSync(path.join(home, 'reply.txt'), 'The bug is at tests/big.test.ts:1900. [R]'));
    expect(past.status).toBe(0);
    expect(past.stderr).toMatch(/UNSUPPORTED EXECUTION CLAIM/);
    const inside = dispatch('codex', [], (home) => writeFileSync(path.join(home, 'reply.txt'), 'The bug is at tests/big.test.ts:5. [R]'));
    expect(inside.status).toBe(0);
    expect(inside.stderr).not.toMatch(/UNSUPPORTED EXECUTION CLAIM/);
  }, 120_000);

  it('1. a codex version the canary has not passed is refused (exit 67) and never sent the task', () => {
    writeFakeCodex('9.9.9');
    try {
      const r = dispatch('codex');
      expect(r.status).toBe(67);
      expect(r.stderr).toMatch(/REFUSED \(CODEX_TOOLS_NOT_PROVABLY_OFF\) — codex: codex 9\.9\.9 has not passed the canary/);
      expect(r.prompt).toBeNull();
    } finally {
      writeFakeCodex('0.162.1');
    }
  }, 120_000);

  it('1. codex-oss is refused (exit 67) even with its model set', () => {
    const r = spawnSync(process.execPath, [RUNNER_PATH, '--agent', 'codex-oss', '--task', 'Reply OK.'], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH, TRUSTKEYS_ENV_MASTER: envMaster, CODEX_OSS_MODEL: 'gpt-oss:20b', ...WIN_ESSENTIALS },
      timeout: 120_000,
    });
    expect(r.status).toBe(67);
    expect(r.stderr).toMatch(/no canary has shown command execution off for the codex-oss lane/);
  }, 120_000);

  it('1. a tool event in the output voids the run (exit 1, NO REVIEW)', () => {
    const r = dispatch('codex', [], (home) =>
      writeFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'cat .env.master' } }) + '\n'),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NO REVIEW — codex used a tool \(command_execution\)/);
  }, 120_000);
});
