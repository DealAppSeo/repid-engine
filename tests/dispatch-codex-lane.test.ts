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

  it('registers codex as an L6 red-team lane with reasoning + repo_read only', () => {
    expect(table.codex).toMatchObject({ cli: 'codex', mode: 'stdin', parses: true });
    expect(table.codex.lane).toMatch(/^L6 RED-TEAM — no write scope$/);
    expect(table.codex.capabilities).toEqual(['reasoning', 'repo_read']);
    expect(table.codex.keyVars[0]).toBe('OPENAI_API_KEY');
  });

  it('registers codex-oss as keyless, reasoning-only, and gated on CODEX_OSS_MODEL', () => {
    expect(table['codex-oss']).toMatchObject({ cli: 'codex', mode: 'stdin', keyVars: [], parses: true });
    expect(table['codex-oss'].capabilities).toEqual(['reasoning']);
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

describe('child env pruning covers codex', () => {
  const INVENTORY = [
    'OPENAI_API_KEY=sk-openai-this-agents-own-key',
    'ANTHROPIC_API_KEY=sk-ant-some-other-credential',
    'XAI_API_KEY=xai-some-other-credential',
    '',
  ].join('\n');
  const inventory = () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dispatch-codex-')), '.env.master');
    writeFileSync(file, INVENTORY, 'utf8');
    return file;
  };
  const built = (agent: string, key: string | null) =>
    call(
      `({buildChildEnv, readAllSecrets, AGENTS}) => buildChildEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-openai-this-agents-own-key', ANTHROPIC_API_KEY: 'sk-ant-some-other-credential', XAI_API_KEY: 'xai-some-other-credential' }, readAllSecrets().keys(), AGENTS[${JSON.stringify(agent)}].keyVars, ${JSON.stringify(key)})`,
      { TRUSTKEYS_ENV_MASTER: inventory() },
    );

  it('codex gets its own OpenAI key (under both names codex reads) and no other secret', () => {
    const env = built('codex', 'sk-openai-this-agents-own-key');
    expect(env.OPENAI_API_KEY).toBe('sk-openai-this-agents-own-key');
    expect(env.CODEX_API_KEY).toBe('sk-openai-this-agents-own-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('codex-oss (local model) gets no inventory secret at all, not even the OpenAI key', () => {
    const env = built('codex-oss', null);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
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
