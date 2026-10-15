/**
 * A HAL measurement run writes nothing to production unless it is told to
 * (scripts/hal-eval/measure-isolation.ts, CC1 2026-10-15).
 *
 * Each case runs in a child process, because the isolation must act before src/config.ts computes
 * LOCAL_MODE, and a jest worker has usually loaded it already. The child stubs `fetch` and records
 * every host it is asked for. It then drives the REAL write paths the HAL path uses: logLlmCall
 * (llm_call_log) and pageOperator (ops_alerts, then a Telegram push).
 *
 * The --write-prod case is the positive control (LESSONS §5). It shows the same probe DOES see the
 * prod database host and api.telegram.org when the writes are allowed, so an empty list in the
 * default case means "nothing went out", not "the probe is blind".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PROD_DB_HOST = 'prod-project.supabase.co';

function probe(args: string[]): { mode: string; db: string; localRows: number; cache: boolean; armed: boolean; hosts: string[] } {
  const p = (rel: string) => JSON.stringify(join(ROOT, rel));
  const code = `
    require('ts-node').register({ transpileOnly: true });
    const hosts = [];
    globalThis.fetch = async (u) => {
      hosts.push(new URL(typeof u === 'string' ? u : u.url || String(u)).host);
      return new Response('[]', { status: 201, headers: { 'content-type': 'application/json' } });
    };
    process.argv = [process.argv[0], 'run-frozen-corpus-local.ts', ...${JSON.stringify(args)}];
    const iso = require(${p('scripts/hal-eval/measure-isolation.ts')});
    const { db } = require(${p('src/db.ts')});
    const { logLlmCall } = require(${p('src/billing/log-call.ts')});
    const pager = require(${p('src/services/operator-pager.ts')});
    const { cacheEnabled } = require(${p('src/cache/dragonfly.ts')});
    (async () => {
      await logLlmCall({ call_id: '00000000-0000-4000-8000-000000000001', provider: 'groq', tier: 'free', model: 'm',
        prompt_tokens: 1, completion_tokens: 1, cost_usd: 0, latency_ms: 1, status: 'success' });
      pager.pageOperator('hal', 'isolation test: extractor fallback');
      await new Promise((r) => setTimeout(r, 500));
      let localRows = -1;
      if (iso.ISOLATION.mode === 'local') localRows = ((await db.from('llm_call_log').select('*')).data || []).length;
      process.stdout.write('PROBE ' + JSON.stringify({ mode: iso.ISOLATION.mode, db: db.constructor.name, localRows,
        cache: cacheEnabled(), armed: pager.pagerStatus().push_armed, hosts }) + '\\n');
      process.exit(0);
    })();
  `;
  const out = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      SUPABASE_URL: `https://${PROD_DB_HOST}`,
      SUPABASE_SERVICE_KEY: 'test-not-a-key',
      REDIS_URL: 'rediss://prod-cache.invalid:6379',
      TELEGRAM_BOT_TOKEN: 'test-not-a-token',
      TELEGRAM_OWNER_CHAT_ID: '1',
      HAL_EVAL_LOCAL_STORE: ':memory:',
      LOCAL_MODE: '',
    },
  });
  const line = (out.stdout || '').split('\n').find((l) => l.startsWith('PROBE '));
  if (!line) throw new Error(`probe printed nothing.\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
  return JSON.parse(line.slice('PROBE '.length));
}

describe('a HAL measurement run is isolated from production by default', () => {
  it('default: db is the local store, the llm_call_log row lands there, no Dragonfly, no Telegram, no prod host', () => {
    const r = probe(['--corpus', 'hal-v1-frozen', '--split', 'all', '--max-calls', '10']);
    expect(r.mode).toBe('local');
    expect(r.db).toBe('LocalStore');
    expect(r.localRows).toBeGreaterThanOrEqual(1);
    expect(r.cache).toBe(false);
    expect(r.armed).toBe(false);
    expect(r.hosts).toEqual([]);
  }, 120_000);

  it('--write-prod (positive control): the same probe sees the prod DB host and Telegram', () => {
    const r = probe(['--corpus', 'hal-v1-frozen', '--write-prod']);
    expect(r.mode).toBe('prod');
    expect(r.db).not.toBe('LocalStore');
    expect(r.cache).toBe(true);
    expect(r.armed).toBe(true);
    expect(r.hosts).toContain(PROD_DB_HOST);
    expect(r.hosts).toContain('api.telegram.org');
  }, 120_000);

  it('the runner imports the isolation before anything else, so config cannot load first', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'hal-eval', 'run-frozen-corpus-local.ts'), 'utf8');
    const firstImport = src.split('\n').find((l) => /^import\b/.test(l));
    expect(firstImport).toBe("import { ISOLATION, isolationBanner } from './measure-isolation';");
    expect(src).toContain('console.log(isolationBanner(ISOLATION));');
  });
});

/**
 * The RUNNER itself, spawned, under a TCP-level probe (XC1 on #1389). Watching `fetch` cannot see
 * Redis or Postgres. tests/fixtures/net-probe.cjs patches net.Socket#connect in the runner and in
 * every child it spawns, records each attempt and blocks it. The env names a fake production
 * Supabase, Redis, Postgres and Telegram, and no provider keys, so every row takes the extractor
 * fallback: the path that pages the operator.
 */
describe('the runner, spawned, opens no TCP connection by default', () => {
  const { mkdtempSync, existsSync: exists } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const PROBE = join(ROOT, 'tests', 'fixtures', 'net-probe.cjs');
  const RUNNER = join(ROOT, 'scripts', 'hal-eval', 'run-frozen-corpus-local.ts');
  const NO_KEYS = [
    'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'QWEN_API_KEY',
    'DASHSCOPE_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY', 'FIREWORKS_API_KEY', 'TOGETHER_API_KEY', 'GLOO_API_KEY',
    'NIM_API_KEY', 'NVIDIA_NIM_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'LOCAL_LLM_BASE_URL',
  ];

  function run(extra: string[]): { status: number | null; stdout: string; lines: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hal-iso-'));
    const probeOut = join(dir, 'net.txt');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NET_PROBE_OUT: probeOut,
      NODE_OPTIONS: `--require ${JSON.stringify(PROBE)}`,
      TS_NODE_TRANSPILE_ONLY: 'true',
      ENV_MASTER_PATH: join(dir, 'no-key-file'),
      HAL_EVAL_OUT_DIR: dir,
      HAL_EVAL_LOCAL_STORE: ':memory:',
      SUPABASE_URL: `https://${PROD_DB_HOST}`,
      SUPABASE_SERVICE_KEY: 'test-not-a-key',
      REDIS_URL: 'rediss://prod-cache.invalid:6379',
      DATABASE_URL: 'postgres://user:pass@prod-db.invalid:5432/postgres',
      SUPABASE_DB_URL: 'postgres://user:pass@prod-db.invalid:5432/postgres',
      TELEGRAM_BOT_TOKEN: 'test-not-a-token',
      TELEGRAM_OWNER_CHAT_ID: '1',
      LOCAL_MODE: '',
    };
    for (const k of NO_KEYS) env[k] = '';
    const out = spawnSync(
      process.execPath,
      ['--require', 'ts-node/register', RUNNER, '--corpus', 'hal-v1-frozen', '--split', 'all', '--limit', '2', ...extra],
      { cwd: ROOT, encoding: 'utf8', timeout: 240_000, env },
    );
    const lines = exists(probeOut) ? readFileSync(probeOut, 'utf8').split('\n').filter(Boolean) : [];
    return { status: out.status, stdout: `${out.stdout}\n${out.stderr}`, lines };
  }

  /** What the probe saw. `probed` is true only when every process that ran had the probe inside it. */
  function verdict(lines: string[]) {
    const of = (tag: string) => lines.filter((l) => l.startsWith(`${tag} `));
    const loaded = of('LOADED').length;
    const spawnNode = of('SPAWN-NODE').length;
    const spawnOther = of('SPAWN-OTHER');
    return {
      loaded,
      spawnNode,
      spawnOther,
      connects: of('CONNECT'),
      dns: of('DNS'),
      probed: loaded > 0 && loaded === 1 + spawnNode && spawnOther.length === 0,
    };
  }

  it('default: every process the runner starts carries the probe, and none connects or resolves', () => {
    const r = run([]);
    const v = verdict(r.lines);
    expect(r.stdout).toContain('ISOLATION  : LOCAL (default)');
    expect(v.spawnNode).toBeGreaterThanOrEqual(1); // the hash child
    expect({ probed: v.probed, loaded: v.loaded, spawnNode: v.spawnNode, spawnOther: v.spawnOther }).toEqual({
      probed: true,
      loaded: 1 + v.spawnNode,
      spawnNode: v.spawnNode,
      spawnOther: [],
    });
    expect(v.connects).toEqual([]);
    expect(v.dns).toEqual([]);
    expect(r.status).toBe(0);
  }, 300_000);

  // The probe's own controls, so an empty list above can only mean "nothing happened".
  function probeSelf(code: string, extraEnv: NodeJS.ProcessEnv = {}): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'hal-probe-'));
    const probeOut = join(dir, 'net.txt');
    spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NET_PROBE_OUT: probeOut, NODE_OPTIONS: `--require ${JSON.stringify(PROBE)}`, ...extraEnv },
    });
    return exists(probeOut) ? readFileSync(probeOut, 'utf8').split('\n').filter(Boolean) : [];
  }

  it('probe control: a DNS lookup is recorded', () => {
    const v = verdict(probeSelf("require('dns').lookup('prod-db.invalid', () => {})"));
    expect(v.dns).toEqual(['DNS prod-db.invalid']);
  }, 120_000);

  it('probe control: a child started with a fresh env, or with --no-node-options, is caught as unprobed', () => {
    const fresh = verdict(probeSelf("require('child_process').spawnSync(process.execPath, ['-e', '1'], { env: {} })"));
    expect(fresh).toMatchObject({ loaded: 1, spawnNode: 1, probed: false });
    const noOpts = verdict(probeSelf("require('child_process').spawnSync(process.execPath, ['--no-node-options', '-e', '1'])"));
    expect(noOpts).toMatchObject({ loaded: 1, spawnNode: 1, probed: false });
    const other = verdict(probeSelf("require('child_process').spawnSync('git', ['--version'])"));
    expect(other.probed).toBe(false);
    expect(other.spawnOther.length).toBe(1);
  }, 120_000);

  it('--write-prod (positive control): the same probe catches the attempts to the prod DB and Telegram', () => {
    const r = run(['--write-prod']);
    expect(r.stdout).toContain('ISOLATION  : PROD (--write-prod)');
    const hosts = r.lines.filter((l) => l.startsWith('CONNECT')).join('\n');
    expect(hosts).toContain(PROD_DB_HOST);
    expect(hosts).toContain('api.telegram.org');
  }, 300_000);
});
