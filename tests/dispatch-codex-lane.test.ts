/**
 * dispatch-codex-lane.test.ts — the OpenAI Codex CLI lane in scripts/dispatch/run-agent.mjs.
 *
 * Same idiom as dispatch-runner-seams.test.ts: import the REAL module in a child Node process
 * (ts-jest + ESM cannot import it in-band), so these cases run the code that dispatches, not a
 * slice of its text. No case here spawns `codex` or reaches OpenAI: argv is built, never run;
 * the two end-to-end cases exit on a refusal before any key is read or any CLI is spawned.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER_PATH = path.resolve(__dirname, '../scripts/dispatch/run-agent.mjs');
// A file:// URL, not a bare path: on Windows `import 'C:/…'` is ERR_UNSUPPORTED_ESM_URL_SCHEME.
const RUNNER = pathToFileURL(RUNNER_PATH).href;

function call(fnBody: string, env: Record<string, string> = {}): any {
  const src = `
    import * as api from '${RUNNER}';
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }),
  );
}

const CTX = { root: 'C:/Users/x/repos/repid-engine-wt', env: { CODEX_OSS_MODEL: 'gpt-oss:20b' } };
const argvOf = (agent: string, prompt = 'THE-PROMPT-TEXT') =>
  call(`({AGENTS}) => AGENTS[${JSON.stringify(agent)}].args(${JSON.stringify(prompt)}, ${JSON.stringify(CTX)})`) as string[];

describe('agent table — codex lanes', () => {
  const table = call(
    `({AGENTS}) => Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { cli: a.cli, mode: a.mode, keyVars: a.keyVars, lane: a.lane, capabilities: a.capabilities, envRequired: a.envRequired ?? [], parses: typeof a.parse === 'function' }]))`,
  );

  it('registers codex as an L6 red-team lane with reasoning + supplied_evidence, NOT repo_read (it cannot open a file)', () => {
    expect(table.codex).toMatchObject({ cli: 'codex', mode: 'stdin', parses: true });
    expect(table.codex.lane).toMatch(/^L6 RED-TEAM — no write scope$/);
    expect(table.codex.capabilities).toEqual(['reasoning', 'supplied_evidence']);
    expect(table.codex.keyVars[0]).toBe('OPENAI_API_KEY');
  });

  it('registers codex-oss as keyless, reasoning over supplied text only, and gated on CODEX_OSS_MODEL', () => {
    expect(table['codex-oss']).toMatchObject({ cli: 'codex', mode: 'stdin', keyVars: [], parses: true });
    expect(table['codex-oss'].capabilities).toEqual(['reasoning', 'supplied_evidence']);
    expect(table['codex-oss'].envRequired).toEqual(['CODEX_OSS_MODEL']);
  });

  it('leaves xc and ga untouched', () => {
    expect(table.xc).toMatchObject({ cli: 'grok', mode: 'argv', keyVars: ['XAI_API_KEY', 'GROK_API_KEY'] });
    expect(table.ga).toMatchObject({ cli: 'gemini', mode: 'stdin', keyVars: ['GEMINI_API_KEY', 'GEMINI_API_KEY_2'] });
  });
});

describe('codex argv / stdin shape', () => {
  it('runs `codex exec` read-only, ephemeral, config-isolated, JSON, rooted at the worktree', () => {
    const a = argvOf('codex');
    expect(a[0]).toBe('exec');
    expect(a[a.indexOf('-s') + 1]).toBe('read-only');
    expect(a[a.indexOf('-C') + 1]).toBe(CTX.root);
    for (const f of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) {
      expect(a).toContain(f);
    }
  });

  it('puts the prompt on stdin (`-`), never on the shell command line', () => {
    // codex is a .cmd shim on Windows -> shell:true -> argv is concatenated unescaped.
    const a = argvOf('codex');
    expect(a[a.length - 1]).toBe('-');
    expect(a.join(' ')).not.toContain('THE-PROMPT-TEXT');
    expect(argvOf('codex-oss').join(' ')).not.toContain('THE-PROMPT-TEXT');
  });

  it('codex-oss adds the local provider and the operator-chosen model, nothing else', () => {
    const base = argvOf('codex');
    const oss = argvOf('codex-oss');
    expect(oss.slice(0, base.length)).toEqual(base);
    expect(oss.slice(base.length)).toEqual(['--oss', '--local-provider', 'ollama', '-m', 'gpt-oss:20b']);
  });

  it('every codex argv element is shell-safe; a hostile path or model is not', () => {
    const safe = (s: string) => call(`({SHELL_SAFE_ARG}) => SHELL_SAFE_ARG.test(${JSON.stringify(s)})`);
    for (const a of argvOf('codex-oss')) expect(safe(a)).toBe(true);
    expect(safe('C:\\Users\\x\\repos\\wt')).toBe(true);
    for (const bad of ['C:/My Repos/wt', 'model&calc', 'a|b', '%PATH%', '"q"']) expect(safe(bad)).toBe(false);
  });
});

describe('forbidden flags — no lane can be handed write scope or an unsandboxed run', () => {
  const forbidden = (s: string) =>
    call(`({FORBIDDEN_ARGS}) => FORBIDDEN_ARGS.some((re) => re.test(${JSON.stringify(s)}))`);

  it('the fence actually matches the dangerous flags (non-vacuity)', () => {
    for (const f of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      'danger-full-access',
      'workspace-write',
      '--full-auto',
      '--approve-for-me',
      '--add-dir',
    ]) {
      expect(forbidden(f)).toBe(true);
    }
    expect(forbidden('read-only')).toBe(false);
  });

  it('no agent in the table builds an argv containing one', () => {
    const offenders = call(
      `({AGENTS, FORBIDDEN_ARGS}) => Object.entries(AGENTS).flatMap(([k, a]) => a.args('<prompt>', ${JSON.stringify(CTX)}).filter((x) => FORBIDDEN_ARGS.some((re) => re.test(x))).map((x) => k + ':' + x))`,
    );
    expect(offenders).toEqual([]);
  });

  it('the dangerous codex flags are not spelled anywhere in the dispatcher', () => {
    const src = readFileSync(RUNNER_PATH, 'utf8');
    expect(src).not.toMatch(/dangerously-bypass/);
    expect(src).not.toMatch(/danger-full-access['"]?\s*[,\]]/); // not as an argv value
  });
});

describe('child env is an ALLOW-LIST (the CLAUDE_CODE_MESSAGING_TOKEN leak, 2026-10-14)', () => {
  // The prune copied the parent env and deleted only names found in .env.master, so a
  // secret the inventory does not list (a Claude Code session token, a stray FOO_API_KEY)
  // reached every child. These pin the replacement.
  const INVENTORY: Record<string, string> = {
    OPENAI_API_KEY: 'sk-openai-lane-key-value',
    XAI_API_KEY: 'xai-lane-key-value-0001',
    GEMINI_API_KEY: 'gemini-lane-key-value-01',
    ANTHROPIC_API_KEY: 'sk-ant-some-other-credential',
    AGENT_KEY_MASTER: 'master-that-decrypts-every-agent-wallet',
    SUPABASE_URL: 'https://inventory-host.example.co',
  };
  // Mixed case on purpose: Windows hands these over as Path / SystemRoot / windir / ComSpec.
  const ESSENTIALS: Record<string, string> = {
    Path: 'C:/Windows/system32;C:/node',
    PATHEXT: '.COM;.EXE;.CMD',
    SystemRoot: 'C:/Windows',
    windir: 'C:/Windows',
    ComSpec: 'C:/Windows/system32/cmd.exe',
    TEMP: 'C:/Users/x/AppData/Local/Temp',
    TMP: 'C:/Users/x/AppData/Local/Temp',
    HOME: '/home/x',
    USERPROFILE: 'C:/Users/x',
    APPDATA: 'C:/Users/x/AppData/Roaming',
    LOCALAPPDATA: 'C:/Users/x/AppData/Local',
    HOMEDRIVE: 'C:',
    HOMEPATH: '/Users/x',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  };
  const LEAKS: Record<string, string> = {
    CLAUDE_CODE_MESSAGING_TOKEN: 'cc-session-token-must-not-leak',
    FOO_API_KEY: 'foo-key-not-in-inventory-123',
    GITHUB_PAT: 'ghp-not-in-inventory-either',
    UNRELATED_SETTING: 'just-some-unrelated-value',
    NODE_OPTIONS: '--require ./not-for-the-child.js',
  };
  const PARENT = { ...ESSENTIALS, ...INVENTORY, ...LEAKS };
  const LANE_KEY: Record<string, string | null> = {
    xc: INVENTORY.XAI_API_KEY!,
    ga: INVENTORY.GEMINI_API_KEY!,
    codex: INVENTORY.OPENAI_API_KEY!,
    'codex-oss': null,
  };
  const AGENT_KEYS = Object.keys(LANE_KEY);

  const childOf = (agent: string, parent: Record<string, string> = PARENT): Record<string, string> =>
    call(
      `({buildChildEnv, AGENTS}) => { const a = AGENTS[${JSON.stringify(agent)}]; return buildChildEnv(${JSON.stringify(parent)}, a.keyVars, ${JSON.stringify(LANE_KEY[agent])}, a.envPassthrough || []); }`,
    );

  it('covers every agent in the table (a new lane cannot skip these cases)', () => {
    expect(call(`({AGENTS}) => Object.keys(AGENTS).sort()`)).toEqual([...AGENT_KEYS].sort());
  });

  it.each(AGENT_KEYS)('%s: the session token, a non-inventory key and an unrelated var do not reach the child', (agent) => {
    const env = childOf(agent);
    for (const name of Object.keys(LEAKS)) expect(env[name]).toBeUndefined();
    expect(Object.values(env)).not.toContain(LEAKS.CLAUDE_CODE_MESSAGING_TOKEN);
  });

  it.each(AGENT_KEYS)('%s: OS essentials pass through with their original casing', (agent) => {
    expect(childOf(agent)).toMatchObject(ESSENTIALS);
  });

  it.each(['xc', 'ga', 'codex'])("%s: the lane's own key reaches the child under every alias", (agent) => {
    const env = childOf(agent);
    const keyVars: string[] = call(`({AGENTS}) => AGENTS[${JSON.stringify(agent)}].keyVars`);
    for (const name of keyVars) expect(env[name]).toBe(LANE_KEY[agent]);
  });

  it.each(AGENT_KEYS)('%s: no child value equals any inventory value other than the lane key', (agent) => {
    // Read the inventory through the real parser, as main() does.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dispatch-allow-')), '.env.master');
    writeFileSync(file, Object.entries(INVENTORY).map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8');
    const inventoryValues: string[] = call(`({readAllSecrets}) => [...readAllSecrets().values()]`, {
      TRUSTKEYS_ENV_MASTER: file,
    });
    expect(inventoryValues).toHaveLength(Object.keys(INVENTORY).length);
    const forbidden = inventoryValues.filter((v) => v !== LANE_KEY[agent]);
    const leaked = Object.entries(childOf(agent)).filter(([, v]) => forbidden.includes(v));
    expect(leaked).toEqual([]);
  });

  it('passthrough is per lane: codex-oss gets its model/config, xc does not', () => {
    const parent = { ...PARENT, CODEX_HOME: 'C:/Users/x/.codex', CODEX_OSS_MODEL: 'gpt-oss:20b' };
    expect(childOf('codex-oss', parent)).toMatchObject({ CODEX_HOME: 'C:/Users/x/.codex', CODEX_OSS_MODEL: 'gpt-oss:20b' });
    expect(childOf('codex', parent).CODEX_HOME).toBe('C:/Users/x/.codex');
    expect(childOf('codex', parent).CODEX_OSS_MODEL).toBeUndefined();
    expect(childOf('xc', parent).CODEX_HOME).toBeUndefined();
  });

  it('codex-oss (local model) carries no credential at all', () => {
    const env = childOf('codex-oss');
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', ...Object.keys(INVENTORY)]) expect(env[name]).toBeUndefined();
  });

  it('every key-like parent value joins the scrub set, and the session token is redacted', () => {
    const values: string[] = call(`({secretishEnvValues}) => secretishEnvValues(${JSON.stringify(PARENT)})`);
    for (const v of [LEAKS.CLAUDE_CODE_MESSAGING_TOKEN, LEAKS.FOO_API_KEY, LEAKS.GITHUB_PAT, INVENTORY.OPENAI_API_KEY]) {
      expect(values).toContain(v);
    }
    for (const v of [ESSENTIALS.Path, ESSENTIALS.HOMEPATH, LEAKS.UNRELATED_SETTING]) expect(values).not.toContain(v);
    const out = call(
      `({makeScrubber, secretishEnvValues}) => makeScrubber(secretishEnvValues(${JSON.stringify(PARENT)}))('echo: cc-session-token-must-not-leak and foo-key-not-in-inventory-123')`,
    );
    expect(out).toBe('echo: <redacted> and <redacted>');
  });

  it('main() spawns with the allow-listed env and scrubs with the env-derived values', () => {
    const src = readFileSync(RUNNER_PATH, 'utf8');
    expect(src).toMatch(/spawnSync\(bin\.cmd, argv, \{[\s\S]{0,200}env: childEnv,/);
    expect(src).toMatch(/secretishEnvValues\(process\.env\)/);
    // The pack and evidence scrub is pinned by BEHAVIOUR, not by grep: dispatch-codex-tools-off.test.ts
    // runs main() against a fake codex and asserts what actually arrived on its stdin.
    expect(src).not.toMatch(/env\s*=\s*\{\s*\.\.\.parentEnv\s*\}/);
  });
});

describe('parseCodexJsonl — the reviewer reads the final answer, not JSONL', () => {
  const parse = (lines: string[]) => call(`({parseCodexJsonl}) => parseCodexJsonl(${JSON.stringify(lines.join('\n'))})`);
  const ev = (o: unknown) => JSON.stringify(o);

  it('keeps the LAST agent message and drops the event plumbing', () => {
    const r = parse([
      ev({ type: 'thread.started', thread_id: 't1' }),
      ev({ type: 'turn.started' }),
      ev({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Looking at the file first.' } }),
      ev({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'internal' } }),
      ev({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'FINAL: no defect found [R]' } }),
      ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    expect(r.text).toBe('FINAL: no defect found [R]');
    expect(r.diag).toBe('');
  });

  it('accepts the older item_type field name', () => {
    const r = parse([ev({ type: 'item.completed', item: { id: 'i0', item_type: 'assistant_message', text: 'OK' } })]);
    expect(r.text).toBe('OK');
  });

  it('surfaces sandboxed commands, errors and non-JSON lines instead of dropping them', () => {
    const r = parse([
      ev({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'rg -n foo', exit_code: 0 } }),
      ev({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
      ev({ type: 'error', message: 'rate limited' }),
      'some stray non-json line',
    ]);
    expect(r.text).toBe('');
    expect(r.diag).toContain('[codex ran, sandboxed] rg -n foo (exit 0)');
    expect(r.diag).toContain('[codex turn.failed] stream disconnected');
    expect(r.diag).toContain('[codex error] rate limited');
    expect(r.diag).toContain('some stray non-json line');
  });

  it('returns empty text when there is no agent message, so the run reads as NO REVIEW', () => {
    expect(parse(['', ev({ type: 'turn.completed' })]).text).toBe('');
  });
});

describe('end to end, refusing before any key is read or CLI is spawned', () => {
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TRUSTKEYS_ENV_MASTER: path.join(tmpdir(), 'definitely-not-here', '.env.master'),
      ...extraEnv,
    };
    delete env.CODEX_OSS_MODEL;
    return spawnSync(process.execPath, [RUNNER_PATH, ...args], { encoding: 'utf8', env });
  };

  it('codex-oss with CODEX_OSS_MODEL unset refuses with exit 2 and names the variable', () => {
    const r = run(['--agent', 'codex-oss', '--task', 'Reply with OK.', '--dry-run']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED — codex-oss needs CODEX_OSS_MODEL/);
    expect(r.stderr).toMatch(/Not picking one silently/);
  });

  it('codex refuses a task that requires shell (seam 1 applies to the new lane)', () => {
    const r = run(['--agent', 'codex', '--task', 'run the tests', '--requires', 'reasoning,shell']);
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/CODEX lacks \[shell\]/);
  });
});
