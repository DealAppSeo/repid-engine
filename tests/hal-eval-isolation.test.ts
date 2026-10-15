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
