/**
 * The restricted worker profile, tested on the real path: the actual CLI as a child process, and
 * the actual role migration applied to a throwaway Postgres and then attacked.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { dbPrivilege, privilegedEnvPresent } from '../src/orchestration/t12-lane-profile';
import {
  LANE_POOL, claimMake, claimStage, coolProvider, coolingProviders, poolDb, readLaneState, recordIntegration, recordVerdict, replenish, submit, type LaneSpec,
} from '../src/orchestration/t12-lane-store';

const ROOT = join(__dirname, '..');
const baseEnv = (extra: Record<string, string>) => ({
  PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', USERPROFILE: process.env.USERPROFILE ?? '', ...extra,
});
function cli(args: string[], env: Record<string, string>, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['-r', preload] : []), 'node_modules/ts-node/dist/bin.js', '--transpile-only', 'scripts/t12/lanes.ts', ...args], { cwd: ROOT, env: baseEnv(env), encoding: 'utf8', timeout: 120_000 });
}

describe('what a worker may hold', () => {
  it.each([
    'DEPLOYER_PRIVATE_KEY', 'TRINITY_DEPLOYER_PRIVATE_KEY', 'BASE_SEPOLIA_PRIVATE_KEY', 'ORCH_PRIVATE_KEY', 'EAS_ATTESTER_PRIVATE_KEY', 'STAKE_ESCROW_SIGNER_KEY',
    'ERC8004_OPERATOR_KEY', 'ERC8004_REPUTATION_WRITER_KEY', 'AGENT_KEY_MASTER', 'TRADING_CREDS_ENCRYPTION_KEY',
    'ALPACA_SECRET_KEY', 'ALPACA_API_KEY', 'COINBASE_API_SECRET', 'STRIPE_SECRET_KEY', 'FIREBLOCKS_API_KEY',
    'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'VERCEL_TOKEN', 'CLOUDFLARE_API_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'LOOP_GH_PAT',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL', 'ADMIN_KEY', 'NEXT_PUBLIC_TRINITY_ADMIN_KEY',
  ])('refuses %s', (name) => expect(privilegedEnvPresent({ [name]: 'x' })).toEqual([name]));
  it.each(['DATABASE_URL', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_NIM_API_KEY', 'OPENROUTER_API_KEY', 'T12_FREE_WAVE', 'PATH'])('allows %s', (name) => {
    expect(privilegedEnvPresent({ [name]: 'x' })).toEqual([]);
  });
  it('an empty variable holds nothing', () => expect(privilegedEnvPresent({ STRIPE_SECRET_KEY: '' })).toEqual([]));
  it('an integrator may hold a GitHub token and nothing else from the list', () => {
    expect(privilegedEnvPresent({ GH_TOKEN: 'x' }, 'integrator')).toEqual([]);
    expect(privilegedEnvPresent({ GH_TOKEN: 'x', DEPLOYER_PRIVATE_KEY: 'y' }, 'integrator')).toEqual(['DEPLOYER_PRIVATE_KEY']);
  });
});

describe('the real CLI refuses a privileged environment', () => {
  it('exits NOT_CHECKED, names the variable, and never prints its value', () => {
    const secret = 'super-secret-value-do-not-print';
    const r = cli(['--specs', 'x', '--work-root', 'y'], { T12_LANES_ENABLED: 'true', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x', STRIPE_SECRET_KEY: secret, RAILWAY_API_TOKEN: secret });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('RAILWAY_API_TOKEN');
    expect(r.stderr).toContain('STRIPE_SECRET_KEY');
    expect(`${r.stdout}${r.stderr}`).not.toContain(secret);
  }, 120_000);
  it('boots with no Supabase service key at all', () => {
    const r = cli(['--work-root', 'y'], { T12_LANES_ENABLED: 'true', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--specs');
    expect(r.stderr).not.toMatch(/SUPABASE_URL and SUPABASE_SECRET_KEY/);
  }, 120_000);
});

const PG = process.env.T12_LANES_PG_URL;
const describePg = PG ? describe : describe.skip;
if (!PG) {
  // eslint-disable-next-line no-console
  console.warn('[t12-lane-profile] NOT_CHECKED: the role block needs T12_LANES_PG_URL (a throwaway Postgres).');
}

describePg('the restricted database role, attacked', () => {
  const CONTROL = [{ file: 'src/thing.mjs', find: '42', replace: '41' }];
  const spec = (id: string): LaneSpec => ({
    id, repo: 'DealAppSeo/trustshell', title: `task ${id}`, prompt: 'Add a focused regression test for the behaviour described in this task.',
    paths: [`tests/${id}.test.mjs`], verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: CONTROL }, risk: 'LOW',
  });
  const DB = 't12_profile_test';
  let admin: Pool;
  let worker: Pool;
  let workerUrl: string;

  beforeAll(async () => {
    const root = new Client({ connectionString: PG });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${DB}`);
    await root.end();
    const u = new URL(PG!);
    u.pathname = `/${DB}`;
    admin = new Pool({ connectionString: u.toString() });
    await admin.query(readFileSync(join(__dirname, 'fixtures/t12-lanes-schema.sql'), 'utf8'));
    // The migration must strip a same-named role that already holds more than it should.
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_lane_worker') THEN CREATE ROLE t12_lane_worker LOGIN; END IF; END $$`);
    await admin.query('ALTER ROLE t12_lane_worker SUPERUSER BYPASSRLS CREATEDB CREATEROLE');
    await admin.query(readFileSync(join(ROOT, 'migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8'));
    u.username = 't12_lane_worker';
    workerUrl = u.toString();
    worker = new Pool({ connectionString: workerUrl, max: 6 });
    await admin.query(`INSERT INTO trinity_tasks (description, status, assigned_to) VALUES ('someone else''s task', 'pending', 'trinity-orch')`);
  });
  afterAll(async () => { await worker.end(); await admin.end(); });

  it('the instrument can tell the difference: owner is privileged, worker is not', async () => {
    expect((await dbPrivilege(admin)).privileged).toBe(true);
    expect(await dbPrivilege(worker)).toEqual({ name: 't12_lane_worker', privileged: false });
  });

  it('can do the whole lane job', async () => {
    const db = poolDb(worker as never);
    await replenish(db, [spec('ok')], 1);
    const c = await claimMake(db, 'trinity-lane-1');
    if (c.kind !== 'claimed') throw new Error(c.reason);
    await submit(db, c.handle, { branch: 'b', commit: 'c1', base: 'b0', files: c.handle.spec.paths, host: 'nvidia' });
    const v = (await claimStage(db, 'awaiting_check', 'trinity-lane-2'))!;
    await recordVerdict(db, v, { outcome: 'approved', commit: 'c1', transcript: 'node --test exited 0 and each control exited 1 as it should.', evidence: {} });
    const i = (await claimStage(db, 'approved', 'trinity-lane-3'))!;
    expect(await recordIntegration(db, i, 'https://example.test/pr/1')).toEqual({ ok: true });
    expect((await readLaneState(worker, c.handle.taskId)).state.stage).toBe('integrated');
    await coolProvider(worker, 'groq', 60, 'rate_limited');
    expect((await coolingProviders(worker)).has('groq')).toBe(true);
  });

  it('cannot see or touch a task outside the lane pool', async () => {
    expect((await worker.query(`SELECT count(*)::int AS n FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].n).toBe(0);
    expect((await worker.query(`UPDATE trinity_tasks SET status = 'done' WHERE assigned_to = 'trinity-orch'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT status FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].status).toBe('pending');
  });

  it('cannot move a task out of the pool or create one outside it', async () => {
    await expect(worker.query(`UPDATE trinity_tasks SET assigned_to = 'trinity-orch' WHERE assigned_to = $1`, [LANE_POOL])).rejects.toThrow(/row-level security/);
    await expect(worker.query(`INSERT INTO trinity_tasks (description, assigned_to) VALUES ('x', 'trinity-orch')`)).rejects.toThrow(/row-level security/);
  });

  it('cannot read scores, cannot delete, cannot change the schema, cannot lift the halt', async () => {
    await expect(worker.query('SELECT * FROM repid_agents')).rejects.toThrow(/permission denied/);
    await expect(worker.query('UPDATE repid_agents SET current_repid = 10000')).rejects.toThrow(/permission denied/);
    await expect(worker.query('DELETE FROM trinity_tasks')).rejects.toThrow(/permission denied/);
    await expect(worker.query('DROP TABLE trinity_tasks')).rejects.toThrow(/must be owner/);
    await expect(worker.query('CREATE TABLE evil (x int)')).rejects.toThrow(/permission denied/);
    await expect(worker.query('UPDATE trinity_system_config SET emergency_halt = false')).rejects.toThrow(/permission denied/);
    await expect(worker.query(`SET ROLE postgres`)).rejects.toThrow(/permission denied|must be member/);
  });

  it('cannot forge a claim row for anything but its own two namespaces', async () => {
    await expect(worker.query(`INSERT INTO agent_resource_claims (resource_kind, resource_id, claimed_by, purpose, expires_at) VALUES ('repo', 'x', 'y', 'z', now() + interval '1 hour')`)).rejects.toThrow(/row-level security/);
  });

  it('the real CLI starts as this role and refuses a role that can bypass row security', () => {
    const dir = mkdtempSync(join(tmpdir(), 't12-prof-'));
    try {
      const specs = join(dir, 's.jsonl');
      writeFileSync(specs, '');
      const args = ['--specs', specs, '--repo', `DealAppSeo/trustshell=${dir}`, '--work-root', join(dir, 'w'), '--lanes', '1'];
      const asOwner = cli(args, { T12_LANES_ENABLED: 'true', DATABASE_URL: workerUrl.replace('t12_lane_worker', 'postgres') });
      expect(asOwner.status).toBe(2);
      expect(asOwner.stderr).toContain('bypass row security');

      const trace = join(dir, 'names.txt');
      const preload = join(__dirname, 'helpers/env-name-trace.js');
      const asWorker = cli(args, { T12_LANES_ENABLED: 'true', DATABASE_URL: workerUrl, ENV_NAME_TRACE_OUT: trace }, preload);
      expect(asWorker.status).toBe(0);
      expect(JSON.parse(asWorker.stdout.slice(asWorker.stdout.indexOf('{')))).toMatchObject({ made: 0, errors: [] });

      // Not "we did not pass them": the running code does not even look for them.
      const read = readFileSync(trace, 'utf8').split('\n').filter(Boolean);
      expect(read.length).toBeGreaterThan(5);
      expect(read).toContain('DATABASE_URL');
      expect(privilegedEnvPresent(Object.fromEntries(read.map((n) => [n, 'x'])))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
