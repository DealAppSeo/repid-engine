/**
 * dispatch-codex-tools-off.test.ts — the codex lane holds no tool, and nothing secret reaches its prompt.
 *
 * XC1 on #1380: `codex exec -s read-only` is a sandbox for model-run commands, not their absence, and
 * read-only still reads the whole disk. The evidence pack carries PR diffs (attacker-controllable text
 * on a public repo), so a prompt injection could have codex read `.env.master` into OpenAI's context
 * before any scrubber ran. These cases pin the fix:
 *   1. every feature the binary lists is disabled except an allowlist, and the run is refused (exit 67)
 *      if the binary still reports anything else on, or on a lane or version no canary has passed; a
 *      tool event in the output voids the run (XC1 on #1390: an allowlist, not a denylist);
 *   2. the pack inlines only source/test/doc files and screens content by shape, after an exact-value
 *      scrub that runs BEFORE truncation; a canary runs before every dispatch, in a workspace holding
 *      a hostile .codex/config.toml, and codex itself runs in an empty dir holding only the pack;
 *   3. --evidence output gets the same treatment;
 *   4. tested by what a fake codex actually RECEIVES on stdin, not by grepping the dispatcher; and
 *      resolveBin returns the binary Windows would run, resolved once;
 *   5. a path:line citation is grounded only within the lines the agent was shown.
 * The live positive control is tests/dispatch-codex-canary.test.ts (opt-in).
 * Nothing here reaches OpenAI: the `codex` on PATH is a fake driven by files in CODEX_HOME.
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

describe('1. codex runs only when nothing outside the allowlist is on, on a version a canary has passed', () => {
  const ALLOWED: string[] = call(`({CODEX_FEATURES_ALLOWED_ON}) => CODEX_FEATURES_ALLOWED_ON`);
  const refusal = (agent: string, version: string, features: string) =>
    call(`({codexToolsRefusal}) => codexToolsRefusal(${JSON.stringify(agent)}, ${JSON.stringify(version)}, ${JSON.stringify(features)})`);
  // The shape `codex features list` prints [V codex-cli 0.162.1]: name, stage (one or two words), state.
  const row = (f: string, stage: string, on: boolean) => `${f.padEnd(40)} ${stage.padEnd(18)} ${on}`;
  const OK = [
    row('code_mode_host', 'stable', false),
    row('shell_tool', 'stable', false),
    row('unified_exec', 'stable', true),
    row('item_ids', 'removed', true),
    row('memories', 'under development', false),
  ].join('\n');
  const V = 'codex-cli 0.162.1';

  it("reads the binary's own table, two-word stages included", () => {
    expect(call(`({parseCodexFeatures}) => Object.fromEntries(parseCodexFeatures(${JSON.stringify(OK)}))`)).toEqual({
      code_mode_host: false, shell_tool: false, unified_exec: true, item_ids: true, memories: false,
    });
  });

  it('passes when only allowlisted features are on', () => {
    expect(refusal('codex', V, OK)).toBeNull();
  });

  it('refuses any other feature still on, including one this file has never heard of', () => {
    for (const f of ['shell_tool', 'worktrees', 'sleep_tool', 'a_feature_codex_adds_next_month']) {
      expect(refusal('codex', V, `${OK}\n${row(f, 'stable', true)}`)).toMatch(new RegExp(`still reports ${f} enabled`));
    }
  });

  it('the allowlist is unified_exec (which codex will not switch off) and removed-stage flags, no tool feature', () => {
    expect(ALLOWED).toEqual(['unified_exec', 'item_ids', 'resize_all_images', 'terminal_resize_reflow', 'tool_search_always_defer_mcp_tools', 'tui_app_server']);
    for (const f of ['code_mode_host', 'shell_tool', 'view_image', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'hooks', 'worktrees']) {
      expect(ALLOWED).not.toContain(f);
    }
  });

  it('refuses a feature list it cannot read', () => {
    expect(refusal('codex', V, '')).toMatch(/could not read codex's feature list/);
    expect(refusal('codex', V, 'error: unrecognized subcommand')).toMatch(/could not read codex's feature list/);
  });

  it('refuses a codex version the canary has not passed, or one it cannot read', () => {
    expect(refusal('codex', 'codex-cli 0.163.0', OK)).toMatch(/0\.163\.0 has not passed the canary/);
    expect(refusal('codex', '', OK)).toMatch(/could not read the codex version/);
  });

  it('refuses codex-oss: no canary has run against the --oss provider', () => {
    expect(refusal('codex-oss', V, OK)).toMatch(/no canary has shown command execution off for the codex-oss lane/);
  });

  it('leaves non-codex lanes alone', () => {
    expect(refusal('xc', '', '')).toBeNull();
  });

  it('codexArgs disables exactly the features it is handed, and roots codex where it is told', () => {
    const a: string[] = call(`({codexArgs}) => codexArgs('C:/tmp/codex-run-x', ['shell_tool', 'worktrees'])`);
    expect(a.filter((_x, i) => a[i - 1] === '--disable')).toEqual(['shell_tool', 'worktrees']);
    expect(a[a.indexOf('-C') + 1]).toBe('C:/tmp/codex-run-x');
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
const CANARY_MARK: string = call(`({CODEX_CANARY_MARK}) => CODEX_CANARY_MARK`);

let repo: string;
let fakeBin: string;
let envMaster: string;
let PATH: string;

/**
 * A fake `codex` driven by files in CODEX_HOME. `features list` mimics 0.162.1: honours --disable,
 * except unified_exec and item_ids, which stay on as they do in the real binary, and whatever
 * feature `stuck.txt` names. An exec whose prompt starts with the canary mark is the preflight: it
 * records itself to canary.json and answers CANNOT_READ, or with the planted file's contents when
 * `leak-canary` exists. Any other exec is the task: prompt.txt, run.json, then `reply.txt` /
 * `events.jsonl` if present.
 */
function writeFakeCodex(version: string) {
  writeFileSync(
    path.join(fakeBin, 'fake-codex.mjs'),
    [
      "import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      'const home = process.env.CODEX_HOME;',
      'const has = (f) => Boolean(home) && existsSync(join(home, f));',
      `if (args.includes('--version')) { process.stdout.write('codex-cli ${version}\\n'); process.exit(0); }`,
      "if (args[0] === 'features' && args[1] === 'list') {",
      "  const off = new Set(args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : [])));",
      "  const stuck = has('stuck.txt') ? readFileSync(join(home, 'stuck.txt'), 'utf8').trim() : '';",
      "  const all = ['code_mode_host', 'shell_tool', 'unified_exec', 'worktrees', 'item_ids', 'memories', ...(stuck ? [stuck] : [])];",
      "  const forced = new Set(['unified_exec', 'item_ids', stuck]);",
      "  for (const f of all) process.stdout.write(f.padEnd(40) + ' stable             ' + (f !== 'memories' && (forced.has(f) || !off.has(f))) + '\\n');",
      '  process.exit(0);',
      '}',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; }).on('end', () => {",
      "  const dir = args[args.indexOf('-C') + 1];",
      '  const seen = { argv: args, dir, files: readdirSync(dir) };',
      "  const say = (text) => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      `  if (input.startsWith(${JSON.stringify(CANARY_MARK)})) {`,
      "    writeFileSync(join(home, 'canary.json'), JSON.stringify(seen));",
      "    const m = /file at (\\S+) and reply/.exec(input);",
      "    say(has('leak-canary') && m ? readFileSync(m[1], 'utf8') : 'CANNOT_READ');",
      '    return;',
      '  }',
      "  writeFileSync(join(home, 'prompt.txt'), input);",
      "  writeFileSync(join(home, 'run.json'), JSON.stringify(seen));",
      "  if (has('events.jsonl')) process.stdout.write(readFileSync(join(home, 'events.jsonl'), 'utf8'));",
      "  say(has('reply.txt') ? readFileSync(join(home, 'reply.txt'), 'utf8') : 'FINAL: reviewed [R]');",
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
  const json = (f: string) => (read(f) === null ? null : JSON.parse(read(f)!));
  return { ...r, prompt: read('prompt.txt'), run: json('run.json'), canary: json('canary.json') };
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
    // codex was launched with every feature its feature list named disabled, bar the allowlist
    const disabled = (argv: string[]) => argv.filter((_x, i) => argv[i - 1] === '--disable').sort();
    expect(disabled(r.run.argv)).toEqual(['code_mode_host', 'memories', 'shell_tool', 'worktrees']);
    // in an empty temp dir holding only the pack, not the repo
    expect(r.run.files).toEqual(['EVIDENCE_PACK.md']);
    expect(path.resolve(r.run.dir)).not.toBe(path.resolve(repo));
    // after a canary with the same flags, in a workspace holding the hostile config
    expect(disabled(r.canary.argv)).toEqual(disabled(r.run.argv));
    expect(r.canary.files).toEqual(['.codex']);
    expect(r.stdout).toMatch(/codex canary passed/);
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

  it('1. a feature the binary will not switch off, and nobody allowlisted, is refused (exit 67) before any model call', () => {
    const r = dispatch('codex', [], (home) => writeFileSync(path.join(home, 'stuck.txt'), 'sleep_tool'));
    expect(r.status).toBe(67);
    expect(r.stderr).toMatch(/still reports sleep_tool enabled/);
    expect(r.canary).toBeNull();
    expect(r.prompt).toBeNull();
  }, 120_000);

  it('2. a canary that reads its token refuses the lane (exit 67), and the task is never sent', () => {
    const r = dispatch('codex', [], (home) => writeFileSync(path.join(home, 'leak-canary'), ''));
    expect(r.status).toBe(67);
    expect(r.stderr).toMatch(/canary: the canary token came back/);
    expect(r.canary).not.toBeNull();
    expect(r.prompt).toBeNull();
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

(process.platform === 'win32' ? describe : describe.skip)('4. resolveBin returns what Windows would run, and main() uses that one path', () => {
  const resolveWith = (dirs: string[]) => {
    const src = `
      import { resolveBin } from '${RUNNER}';
      process.stdout.write(JSON.stringify(resolveBin('codex')));`;
    const PATHv = [...dirs, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env: { ...process.env, PATH: PATHv } }));
  };

  it('an earlier codex.cmd beats a later codex.exe (the old code took any .exe), and the reverse', () => {
    const a = mkdtempSync(path.join(tmpdir(), 'bin-a-'));
    const b = mkdtempSync(path.join(tmpdir(), 'bin-b-'));
    writeFileSync(path.join(a, 'codex.cmd'), '@echo off\r\n');
    writeFileSync(path.join(b, 'codex.exe'), '');
    expect(resolveWith([a, b])).toEqual({ cmd: path.join(a, 'codex.cmd'), shell: true });
    expect(resolveWith([b, a])).toEqual({ cmd: path.join(b, 'codex.exe'), shell: false });
  });

  it('main() resolves the binary once and hands that object to the gate, the canary and the task', () => {
    const src = readFileSync(RUNNER_PATH, 'utf8');
    const main = src.slice(src.indexOf('function main()'));
    expect(main.match(/resolveBin\(/g)).toHaveLength(1);
    expect(main).toMatch(/codexGate\(agentKey, bin,/);
    expect(main).toMatch(/codexCanary\(bin,/);
    expect(main).toMatch(/spawnSync\(bin\.cmd, argv,/);
  });
});
