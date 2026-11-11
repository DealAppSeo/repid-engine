/**
 * The restricted worker profile, tested on the real path: the actual CLI as a child process, and
 * the actual role migration applied to a throwaway Postgres and then attacked. Each stage has its own
 * database role. `worker` below is the maker's, the one that runs next to model output; the checker
 * and integrator roles are attacked in their own block.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { KNOWN_ENV_VARS } from '../src/config/known-env-vars.generated';
import { T12_ROUTES } from '../src/orchestration/t12-attempt';
import { dbPrivilege, privilegedEnvPresent, reachableDefiners } from '../src/orchestration/t12-lane-profile';
import { runLanes, type LaneAdapters } from '../src/orchestration/t12-lane-runner';
import {
  LANE_POOL, checkoutBelt, claimMake, claimStage, coolProvider, coolingProviders, pgHaltClient, poolDb, readLaneState, recordIntegration, recordVerdict, recoverStages, releaseMake, replenish, submit,
  type Handle, type LaneSpec,
} from '../src/orchestration/t12-lane-store';

const ROOT = join(__dirname, '..');
const MIGRATION = join(ROOT, 'migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql');
const LANE_ROLES = ['t12_lane_maker', 't12_lane_checker', 't12_lane_integrator'] as const;
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
  it.each(['DATABASE_URL', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_NIM_API_KEY', 'T12_FREE_WAVE', 'PATH'])('allows %s', (name) => {
    expect(privilegedEnvPresent({ [name]: 'x' })).toEqual([]);
  });
  it.each([
    'RECEIPT_SIGNING_KEY', 'KERNEL_RECEIPT_SIGNING_KEY', 'CONTROLLER_MASTER_KEY', 'AUDIT_MASTER_KEY', 'AUDIT_BINDING_KEY', 'KERNEL_COMMITMENT_KEY', 'SIGNING_KEY_DEV',
    'FULL_ACCOUNT_JWT_SECRET', 'ORACLE_HMAC_SECRET', 'PROOF_SECRET', 'TELEGRAM_BOT_TOKEN', 'CRON_TRIGGER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY',
  ])('refuses %s, which no fixed spelling named', (name) => expect(privilegedEnvPresent({ [name]: 'x' })).toEqual([name]));
  it('refuses every credential the engine registers, except the keys of the free routes', () => {
    const free = new Set(Object.values(T12_ROUTES).filter((r) => r.freeOnly).flatMap((r) => [...r.keyEnv]));
    const credentials = KNOWN_ENV_VARS.filter((n) => /_SECRET$|SIGNING_KEY|MASTER_KEY|_TOKEN$|_API_KEY$/.test(n) && !free.has(n));
    expect(credentials.length).toBeGreaterThan(20);
    expect(privilegedEnvPresent(Object.fromEntries(credentials.map((n) => [n, 'x'])))).toEqual([...credentials].sort());
  });
  it('allows the key of every route not known to hold paid credit', () => {
    const keys = Object.values(T12_ROUTES).filter((r) => r.freeOnly).flatMap((r) => [...r.keyEnv]);
    expect(keys.length).toBeGreaterThan(3);
    expect(privilegedEnvPresent(Object.fromEntries(keys.map((n) => [n, 'x'])))).toEqual([]);
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
  it('refuses to publish and run model-written code in one process', () => {
    const r = cli(['--specs', 'x', '--work-root', 'y'], { T12_LANES_ENABLED: 'true', T12_LANES_PUBLISH: 'true', T12_LANES_ALLOW_EXEC: 'true', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must not be set together');
  }, 120_000);
  it('bounds the model timeout, and grants a long one only to a local model', () => {
    const env = { T12_LANES_ENABLED: 'true', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' };
    const base = ['--specs', 'ops/t12/specs.jsonl', '--work-root', 'y', '--ask-timeout-ms'];
    const tooLong = cli([...base, '900000'], { ...env, T12_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1' });
    expect(tooLong.status).toBe(2);
    expect(tooLong.stderr).toContain('from 10000 to 600000');
    const remote = cli([...base, '300000'], { ...env, T12_LOCAL_BASE_URL: 'https://example.com/v1' });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toContain('only for a local model');
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
  let checker: Pool;
  let integrator: Pool;
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
    // The migration must strip a same-named role that already holds more than it should, and disarm
    // the retired shared role, which could approve its own work, if an earlier draft created it.
    for (const r of [...LANE_ROLES, 't12_lane_worker']) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} LOGIN; END IF; END $$`);
      await admin.query(`ALTER ROLE ${r} LOGIN SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION`);
      await admin.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${r}`);
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${r}`);
      await admin.query(`GRANT postgres TO ${r}`);
      await admin.query(`GRANT ALL ON principal_grants, trinity_agent_logs, repid_agents, trinity_tasks TO ${r}`);
    }
    // One definer function open to PUBLIC, as most start out, and one already closed to it.
    await admin.query('CREATE OR REPLACE FUNCTION public.t12_probe_open() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
    await admin.query('CREATE OR REPLACE FUNCTION public.t12_probe_closed() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
    await admin.query('REVOKE ALL ON FUNCTION public.t12_probe_closed() FROM PUBLIC, anon');
    // Holds no grant of its own, so anything it can call, it reaches only through PUBLIC.
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_public_only') THEN CREATE ROLE t12_public_only NOLOGIN; END IF; END $$`);
    await admin.query('GRANT USAGE ON SCHEMA public TO t12_public_only');
    await admin.query(readFileSync(MIGRATION, 'utf8'));
    const as = (r: string) => { u.username = r; return u.toString(); };
    workerUrl = as('t12_lane_maker');
    worker = new Pool({ connectionString: workerUrl, max: 6 });
    checker = new Pool({ connectionString: as('t12_lane_checker'), max: 4 });
    integrator = new Pool({ connectionString: as('t12_lane_integrator'), max: 4 });
    await admin.query(`INSERT INTO trinity_tasks (description, status, assigned_to) VALUES ('someone else''s task', 'pending', 'trinity-orch')`);
  });
  afterAll(async () => { await worker.end(); await checker.end(); await integrator.end(); await admin.end(); });

  it('the instrument can tell the difference: owner is privileged, no lane role is', async () => {
    expect((await dbPrivilege(admin)).privileged).toBe(true);
    expect(await dbPrivilege(worker)).toEqual({ name: 't12_lane_maker', privileged: false });
    expect(await dbPrivilege(checker)).toEqual({ name: 't12_lane_checker', privileged: false });
    expect(await dbPrivilege(integrator)).toEqual({ name: 't12_lane_integrator', privileged: false });
  });

  it('can do the whole lane job, each stage under its own role', async () => {
    const maker = poolDb(worker as never);
    await replenish(maker, [spec('ok')], 1);
    const c = await claimMake(maker, 'trinity-lane-1');
    if (c.kind !== 'claimed') throw new Error(c.reason);
    expect(await checkoutBelt(maker, c.handle)).toMatchObject({ ok: true, belt: 'engineering' });
    expect(await submit(maker, c.handle, { branch: `t12/ok-e${c.handle.epoch}`, commit: 'a'.repeat(40), base: 'b'.repeat(40), files: c.handle.spec.paths, host: 'nvidia' })).toEqual({ ok: true });
    const v = (await claimStage(poolDb(checker as never), 'awaiting_check', 'trinity-lane-2'))!;
    expect(await recordVerdict(poolDb(checker as never), v, { outcome: 'approved', commit: 'a'.repeat(40), transcript: 'node --test exited 0 and each control exited 1 as it should.', evidence: {} })).toEqual({ ok: true });
    const i = (await claimStage(poolDb(integrator as never), 'approved', 'trinity-lane-3'))!;
    expect(await recordIntegration(poolDb(integrator as never), i, 'https://example.test/pr/1')).toEqual({ ok: true });
    const done = (await readLaneState(worker, c.handle.taskId)).state;
    expect(done.stage).toBe('integrated');
    expect(['submitted', 'check_approved', 'integrated'].map((e) => done.receipts.find((r) => r.event === e)!.actor)).toEqual(['trinity-lane-1', 'trinity-lane-2', 'trinity-lane-3']);
    await coolProvider(worker, 'groq', 60, 'rate_limited');
    expect((await coolingProviders(worker)).has('groq')).toBe(true);
  });

  it('cannot see or touch a task outside the lane pool', async () => {
    expect((await worker.query(`SELECT count(*)::int AS n FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].n).toBe(0);
    expect((await worker.query(`UPDATE trinity_tasks SET status = 'done' WHERE assigned_to = 'trinity-orch'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT status FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].status).toBe('pending');
  });

  it('cannot move a task out of the pool or create one outside it', async () => {
    await expect(worker.query(`UPDATE trinity_tasks SET assigned_to = 'trinity-orch' WHERE assigned_to = $1`, [LANE_POOL])).rejects.toThrow(/permission denied/);
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

  describe('a task-bound belt, attacked on the real write path', () => {
    const db = () => poolDb(worker as never);
    let n = 0;
    async function claimed(extra: Partial<LaneSpec> = {}): Promise<Handle> {
      const id = `belt-${++n}`;
      await replenish(db(), [{ ...spec(id), ...extra }], 1);
      const c = await claimMake(db(), 'trinity-lane-1');
      if (c.kind !== 'claimed' || c.handle.spec.id !== id) throw new Error(`did not claim ${id}`);
      return c.handle;
    }
    const work = (h: Handle, files = h.spec.paths) => ({ branch: `t12/${h.spec.id}-e${h.epoch}`, commit: 'a'.repeat(40), base: 'b'.repeat(40), files, host: 'nvidia' });
    const denials = async (h: Handle) => (await admin.query(`SELECT message FROM trinity_agent_logs WHERE task_id = $1 AND action = 'belt_denied'`, [h.taskId])).rows.map((r) => r.message);
    const events = async (h: Handle) => (await readLaneState(worker, h.taskId)).state.receipts.map((r) => r.event);
    const stage = async (h: Handle) => (await readLaneState(worker, h.taskId)).state.stage;
    const key = (h: Handle) => `t12:${h.taskId}:${h.epoch}`;
    const rawSubmit = (h: Handle, files: string[]) => worker.query(
      `UPDATE trinity_tasks SET metadata = jsonb_set(jsonb_set(metadata, '{t12,submission}', $2::jsonb), '{t12,stage}', '"awaiting_check"') WHERE id = $1`,
      [h.taskId, JSON.stringify(work(h, files))],
    );

    it('a checked-out belt allows exactly that submission, as a positive control', async () => {
      const h = await claimed();
      expect(await checkoutBelt(db(), h)).toMatchObject({ ok: true, belt: 'engineering' });
      expect(await submit(db(), h, work(h))).toEqual({ ok: true });
      expect(await stage(h)).toBe('awaiting_check');
      const grant = (await admin.query('SELECT * FROM principal_grants WHERE idempotency_key = $1', [key(h)])).rows[0];
      expect(grant).toMatchObject({ grantor_agent_id: 't12-belt-issuer', grantee_agent_id: 'trinity-lane-1', grant_class: 'cold', role: 'engineering' });
      expect(await events(h)).toContain('belt_checked_out');
    });

    it('refuses a submission with no belt, and nothing lands on the row', async () => {
      const h = await claimed();
      await expect(rawSubmit(h, h.spec.paths)).rejects.toThrow(/row-level security/);
      expect((await readLaneState(worker, h.taskId)).state.submission).toBeUndefined();
      expect(await stage(h)).toBe('making');
    });

    it('refuses an expired belt and records why where the worker cannot edit it', async () => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await admin.query(`UPDATE principal_grants SET not_before = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE idempotency_key = $1`, [key(h)]);
      expect(await submit(db(), h, work(h))).toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
      expect(await denials(h)).toEqual(['the belt for this claim has expired']);
      expect(await events(h)).toEqual(expect.arrayContaining(['belt_checked_out', 'belt_denied', 'maker_failed']));
      expect(await stage(h)).toBe('ready');
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('refuses a revoked belt, and the claim cannot simply check out another', async () => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await admin.query(`UPDATE principal_grants SET revoked_at = now(), revoked_by = 'owner' WHERE idempotency_key = $1`, [key(h)]);
      await expect(rawSubmit(h, h.spec.paths)).rejects.toThrow(/row-level security/);
      expect(await checkoutBelt(db(), h)).toEqual({ ok: false, reason: 'the belt for this claim was revoked' });
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it.each([
      ['main', { branch: 'main' }],
      ['a full ref', { branch: 'refs/heads/main' }],
      ['another task', { branch: 't12/other-e1' }],
      ['an option as the commit', { commit: '--force' }],
      ['a symbolic commit', { commit: 'HEAD' }],
      ['an option as the base', { base: '--output=/tmp/x' }],
    ])('with a live belt, cannot submit %s', async (_n, over) => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await expect(worker.query(
        `UPDATE trinity_tasks SET metadata = jsonb_set(jsonb_set(metadata, '{t12,submission}', $2::jsonb), '{t12,stage}', '"awaiting_check"') WHERE id = $1`,
        [h.taskId, JSON.stringify({ ...work(h), ...over })],
      )).rejects.toThrow(/row-level security/);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('a belt naming a different lane does not cover the holder', async () => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await admin.query(`UPDATE principal_grants SET grantee_agent_id = 'trinity-lane-2' WHERE idempotency_key = $1`, [key(h)]);
      await expect(rawSubmit(h, h.spec.paths)).rejects.toThrow(/row-level security/);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('a belt from an earlier claim does not carry over to a later one', async () => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await releaseMake(db(), h, 'host down', true);
      const again = await claimMake(db(), 'trinity-lane-1');
      if (again.kind !== 'claimed' || again.handle.taskId !== h.taskId) throw new Error('did not reclaim');
      expect(again.handle.epoch).toBeGreaterThan(h.epoch);
      await expect(rawSubmit(again.handle, h.spec.paths)).rejects.toThrow(/row-level security/);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('a research belt cannot write code, and is denied before any grant exists', async () => {
      const h = await claimed({ belt: 'research' });
      expect(await checkoutBelt(db(), h)).toEqual({ ok: false, reason: 'the research belt does not cover the paths of this task' });
      expect((await admin.query('SELECT count(*)::int AS n FROM principal_grants WHERE idempotency_key = $1', [key(h)])).rows[0].n).toBe(0);
      expect(await denials(h)).toHaveLength(1);
      expect(await events(h)).toContain('belt_denied');
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('a research belt can file a report, as a positive control', async () => {
      const h = await claimed({ belt: 'research', paths: ['reports/finding.md'], verify: { runner: 'node-test', target: 'reports/finding.md', controls: CONTROL } });
      expect(await checkoutBelt(db(), h)).toMatchObject({ ok: true, belt: 'research' });
      expect(await submit(db(), h, work(h))).toEqual({ ok: true });
    });

    it('refuses files beyond the task or the belt even with a live belt', async () => {
      const h = await claimed();
      await checkoutBelt(db(), h);
      await expect(rawSubmit(h, ['tests/some-other.test.mjs'])).rejects.toThrow(/row-level security/);
      await expect(rawSubmit(h, ['package.json'])).rejects.toThrow(/row-level security/);
      await expect(rawSubmit(h, [])).rejects.toThrow(/row-level security/);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it.each(['package.json', '.github/workflows/x.yml', 'src/../package.json', 'tests/..', 'src\\x.ts', 'src/.env', 'tests/.npmrc', 'scripts/x.sh'])('no belt covers %s', async (path) => {
      const q = 'SELECT t12_belt_paths_ok($1, $2::jsonb) AS ok';
      expect((await admin.query(q, ['engineering', JSON.stringify([path])])).rows[0].ok).toBe(false);
      expect((await admin.query(q, ['research', JSON.stringify([path])])).rows[0].ok).toBe(false);
      expect((await admin.query(q, ['engineering', JSON.stringify(['src/a.ts'])])).rows[0].ok).toBe(true);
    });

    it('cannot rewrite the task, skip the belt, or plant finished work', async () => {
      const h = await claimed();
      await expect(worker.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,spec,paths}', '["src/evil.ts"]') WHERE id = $1`, [h.taskId])).rejects.toThrow(/row-level security/);
      await expect(worker.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"approved"') WHERE id = $1`, [h.taskId])).rejects.toThrow(/row-level security/);
      const planted = (t12: object) => worker.query(`INSERT INTO trinity_tasks (description, assigned_to, metadata) VALUES ('x', $1, $2::jsonb)`, [LANE_POOL, JSON.stringify({ t12 })]);
      await expect(planted({ spec: spec('p1'), stage: 'approved', epoch: 1 })).rejects.toThrow(/row-level security/);
      await expect(planted({ spec: spec('p2'), stage: 'ready', epoch: 0, submission: work(h) })).rejects.toThrow(/row-level security/);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('cannot mint a belt, restore one, read them, or touch the denial log', async () => {
      await expect(worker.query(`INSERT INTO principal_grants (grantor_agent_id, grantee_agent_id, grant_class, expires_at, idempotency_key) VALUES ('t12-belt-issuer', 'trinity-lane-1', 'cold', now() + interval '1 hour', 't12:1:1')`)).rejects.toThrow(/permission denied/);
      await expect(worker.query('UPDATE principal_grants SET revoked_at = NULL, revoked_by = NULL')).rejects.toThrow(/permission denied/);
      await expect(worker.query('SELECT * FROM principal_grants')).rejects.toThrow(/permission denied/);
      await expect(worker.query('SELECT * FROM trinity_agent_logs')).rejects.toThrow(/permission denied/);
      await expect(worker.query('DELETE FROM trinity_agent_logs')).rejects.toThrow(/permission denied/);
    });

    const asRole = async (role: string, sql: string) => {
      const c = await admin.connect();
      try {
        await c.query(`SET ROLE ${role}`);
        return await c.query(sql);
      } finally {
        await c.query('RESET ROLE');
        c.release();
      }
    };

    it('cannot call a definer function that was open to PUBLIC, and no other role loses or gains', async () => {
      await expect(worker.query('SELECT public.t12_probe_open()')).rejects.toThrow(/permission denied/);
      await expect(worker.query('SELECT public.t12_probe_closed()')).rejects.toThrow(/permission denied/);
      expect((await asRole('anon', 'SELECT public.t12_probe_open() AS x')).rows[0].x).toBe(1);
      await expect(asRole('anon', 'SELECT public.t12_probe_closed()')).rejects.toThrow(/permission denied/);
      expect((await asRole('t12_public_only', 'SELECT public.t12_probe_open() AS x')).rows[0].x).toBe(1);
      await expect(asRole('t12_public_only', 'SELECT public.t12_probe_closed()')).rejects.toThrow(/permission denied/);
      expect(await reachableDefiners(worker)).toEqual([]);
    });

    it('a definer function added later is seen, and the real CLI refuses to start', async () => {
      await admin.query('CREATE FUNCTION public.t12_probe_late() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
      const dir = mkdtempSync(join(tmpdir(), 't12-late-'));
      try {
        expect(await reachableDefiners(worker)).toEqual(['t12_probe_late()']);
        const specs = join(dir, 's.jsonl');
        writeFileSync(specs, '');
        const r = cli(['--specs', specs, '--repo', `DealAppSeo/trustshell=${dir}`, '--work-root', join(dir, 'w'), '--lanes', '1'], { T12_LANES_ENABLED: 'true', DATABASE_URL: workerUrl });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('t12_probe_late()');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await admin.query('DROP FUNCTION public.t12_probe_late()');
      }
    }, 180_000);

    it('checkout locks nothing outside the pool and logs no denial there, and does lock a lane task', async () => {
      const h = await claimed();
      const outside = Number((await admin.query(`SELECT id FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].id);
      const w = await worker.connect();
      try {
        await w.query('BEGIN');
        await w.query('SELECT t12_belt_checkout($1, $2, $3)', [outside, h.actor, 1]);
        await expect(admin.query('SELECT id FROM trinity_tasks WHERE id = $1 FOR UPDATE NOWAIT', [outside])).resolves.toBeDefined();
        await w.query('SELECT t12_belt_checkout($1, $2, $3)', [h.taskId, 'trinity-lane-2', h.epoch]);
        await expect(admin.query('SELECT id FROM trinity_tasks WHERE id = $1 FOR UPDATE NOWAIT', [h.taskId])).rejects.toThrow(/could not obtain lock/);
      } finally {
        await w.query('ROLLBACK');
        w.release();
      }
      await worker.query('SELECT t12_belt_checkout($1, $2, $3)', [outside, h.actor, 1]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM trinity_agent_logs WHERE task_id = $1`, [outside])).rows[0].n).toBe(0);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('repeated denials of one task and reason write one log row', async () => {
      const h = await claimed({ belt: 'research' });
      for (let i = 0; i < 4; i++) await worker.query('SELECT t12_belt_checkout($1, $2, $3)', [h.taskId, h.actor, h.epoch]);
      expect(await denials(h)).toHaveLength(1);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('cannot put a non-lane principal on a row or mint a belt for one', async () => {
      const h = await claimed();
      await expect(worker.query(`UPDATE trinity_tasks SET claimed_by = 'trinity-orch' WHERE id = $1`, [h.taskId])).rejects.toThrow(/row-level security/);
      // The function refuses it on its own too, even if something else put that name on the row.
      await admin.query(`UPDATE trinity_tasks SET claimed_by = 'trinity-orch' WHERE id = $1`, [h.taskId]);
      expect((await worker.query('SELECT t12_belt_checkout($1, $2, $3) AS r', [h.taskId, 'trinity-orch', h.epoch])).rows[0].r).toEqual({ ok: false, reason: 'the grantee is not a lane' });
      expect((await admin.query('SELECT count(*)::int AS n FROM principal_grants WHERE idempotency_key = $1', [key(h)])).rows[0].n).toBe(0);
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('cannot check out for another lane, an old claim, or a task outside the pool', async () => {
      const h = await claimed();
      const ask = (task: number, lane: string, epoch: number) => worker.query('SELECT t12_belt_checkout($1, $2, $3) AS r', [task, lane, epoch]).then((x) => x.rows[0].r);
      expect(await ask(h.taskId, 'trinity-lane-2', h.epoch)).toEqual({ ok: false, reason: 'another lane holds this task' });
      expect(await ask(h.taskId, h.actor, h.epoch - 1)).toEqual({ ok: false, reason: 'stale claim' });
      const outside = (await admin.query(`SELECT id FROM trinity_tasks WHERE assigned_to = 'trinity-orch'`)).rows[0].id;
      expect(await ask(Number(outside), h.actor, 1)).toEqual({ ok: false, reason: 'task is not in the lane pool' });
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('anon cannot call the belt functions, though Supabase defaults would let it', async () => {
      await admin.query('CREATE OR REPLACE FUNCTION public.t12_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      const c = await admin.connect();
      try {
        await c.query('SET ROLE anon');
        expect((await c.query('SELECT public.t12_probe() AS x')).rows[0].x).toBe(1);
        await expect(c.query(`SELECT public.t12_belt_checkout(1, 'x', 1)`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`SELECT public.t12_belt_permits(1, '{}'::jsonb)`)).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('RESET ROLE');
        c.release();
      }
    });

    it.each(['done', 'verified', 'shadow_reject'])('cannot move a task to %s, the status the RepID bridge scores', async (status) => {
      const h = await claimed();
      await expect(worker.query('UPDATE trinity_tasks SET status = $2 WHERE id = $1', [h.taskId, status])).rejects.toThrow(/row-level security/);
      await expect(worker.query(`INSERT INTO trinity_tasks (description, status, assigned_to) VALUES ('x', $1, $2)`, [status, LANE_POOL])).rejects.toThrow(/row-level security/);
      expect((await admin.query('SELECT status FROM trinity_tasks WHERE id = $1', [h.taskId])).rows[0].status).toBe('claimed');
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId]);
    });

    it('cannot write the result column, and can write a lane status, as a positive control', async () => {
      const h = await claimed();
      await expect(worker.query(`UPDATE trinity_tasks SET result = 'forged' WHERE id = $1`, [h.taskId])).rejects.toThrow(/permission denied/);
      await expect(worker.query(`INSERT INTO trinity_tasks (description, assigned_to, result) VALUES ('x', $1, 'forged')`, [LANE_POOL])).rejects.toThrow(/permission denied/);
      expect((await worker.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [h.taskId])).rowCount).toBe(1);
    });

    it('the migration removes REPLICATION and any default privilege, so a table created later stays closed', async () => {
      for (const r of LANE_ROLES) expect((await admin.query(`SELECT rolreplication FROM pg_roles WHERE rolname = $1`, [r])).rows[0].rolreplication).toBe(false);
      await admin.query('CREATE TABLE t12_created_later (x int)');
      try {
        await expect(worker.query('SELECT * FROM t12_created_later')).rejects.toThrow(/permission denied/);
      } finally {
        await admin.query('DROP TABLE t12_created_later');
      }
    });

    it('a role with REPLICATION is privileged, because decoding the log skips row security', async () => {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_replication_probe') THEN CREATE ROLE t12_replication_probe LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
      await admin.query('ALTER ROLE t12_replication_probe NOREPLICATION');
      const u = new URL(workerUrl);
      u.username = 't12_replication_probe';
      const probe = new Pool({ connectionString: u.toString() });
      try {
        expect(await dbPrivilege(probe)).toEqual({ name: 't12_replication_probe', privileged: false });
        await admin.query('ALTER ROLE t12_replication_probe REPLICATION');
        expect(await dbPrivilege(probe)).toEqual({ name: 't12_replication_probe', privileged: true });
      } finally {
        await probe.end();
        await admin.query('ALTER ROLE t12_replication_probe NOREPLICATION');
      }
    });

    it('a role that holds a superuser by membership is reported as privileged', async () => {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_member_probe') THEN CREATE ROLE t12_member_probe LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
      await admin.query('GRANT postgres TO t12_member_probe');
      const u = new URL(workerUrl);
      u.username = 't12_member_probe';
      const probe = new Pool({ connectionString: u.toString() });
      try {
        expect(await dbPrivilege(probe)).toEqual({ name: 't12_member_probe', privileged: true });
      } finally {
        await probe.end();
        await admin.query('REVOKE postgres FROM t12_member_probe');
      }
    });

    it('a role that owns a table is privileged, because an owner skips row policies, and the real CLI refuses it', async () => {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_owner_probe') THEN CREATE ROLE t12_owner_probe LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
      const u = new URL(workerUrl);
      u.username = 't12_owner_probe';
      const probe = new Pool({ connectionString: u.toString() });
      const dir = mkdtempSync(join(tmpdir(), 't12-owner-'));
      try {
        expect(await dbPrivilege(probe)).toEqual({ name: 't12_owner_probe', privileged: false });
        await admin.query('CREATE TABLE t12_owner_probe_table (x int)');
        await admin.query('ALTER TABLE t12_owner_probe_table OWNER TO t12_owner_probe');
        expect(await dbPrivilege(probe)).toEqual({ name: 't12_owner_probe', privileged: true });
        const specs = join(dir, 's.jsonl');
        writeFileSync(specs, '');
        const r = cli(['--specs', specs, '--repo', `DealAppSeo/trustshell=${dir}`, '--work-root', join(dir, 'w'), '--lanes', '1'], { T12_LANES_ENABLED: 'true', DATABASE_URL: u.toString() });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('bypass row security');
      } finally {
        await probe.end();
        await admin.query('DROP TABLE IF EXISTS t12_owner_probe_table');
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);

    it('re-applying the migration strips a new membership and grant, and refuses a role that owns objects', async () => {
      const file = readFileSync(MIGRATION, 'utf8');
      await admin.query('GRANT postgres TO t12_lane_maker');
      await admin.query('GRANT SELECT ON principal_grants TO t12_lane_maker');
      await admin.query(file);
      await expect(worker.query('SET ROLE postgres')).rejects.toThrow(/permission denied|must be member/);
      await expect(worker.query('SELECT * FROM principal_grants')).rejects.toThrow(/permission denied/);
      await admin.query('CREATE TABLE t12_owned_probe (x int)');
      await admin.query('ALTER TABLE t12_owned_probe OWNER TO t12_lane_maker');
      const c = await admin.connect();
      try {
        await expect(c.query(file)).rejects.toThrow(/owns database objects/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
        await admin.query('DROP TABLE t12_owned_probe');
      }
    });

    it('a refusal stops the whole file when statements run one at a time, as psql -f does', async () => {
      const file = readFileSync(MIGRATION, 'utf8');
      // Split as psql would: on semicolons outside dollar-quoted bodies and comments.
      const statements: string[] = [];
      let current = '';
      file.split('$$').forEach((segment, i) => {
        if (i % 2 === 1) {
          current += `$$${segment}$$`;
          return;
        }
        const parts = segment.replace(/--[^\n]*/g, '').split(';');
        current += parts[0];
        for (const part of parts.slice(1)) {
          statements.push(current);
          current = part;
        }
      });
      await admin.query('DROP POLICY t12_lane_halt ON trinity_system_config');
      await admin.query('CREATE TABLE t12_owned_probe (x int)');
      await admin.query('ALTER TABLE t12_owned_probe OWNER TO t12_lane_maker');
      const errors: string[] = [];
      const c = await admin.connect();
      try {
        for (const s of statements) await c.query(s).catch((e: Error) => errors.push(e.message));
      } finally {
        c.release();
      }
      try {
        expect(statements.length).toBeGreaterThan(20);
        expect(errors[0]).toMatch(/owns database objects/);
        const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 't12_lane_halt'`);
        expect(rows[0].n).toBe(0);
      } finally {
        await admin.query('DROP TABLE t12_owned_probe');
        await admin.query(file);
      }
    });

    it('holds no role or membership that reaches past the policy', async () => {
      for (const p of [worker, checker, integrator]) {
        const { rows } = await p.query(`SELECT r.rolname FROM pg_roles r WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'member')`);
        expect(rows).toEqual([]);
      }
    });

    it('on the real runner, a denied belt never reaches the model', async () => {
      const calls: string[] = [];
      const adapters: LaneAdapters = {
        make: async (h) => { calls.push(h.spec.id); return { ok: false, kind: 'maker_failed', reason: 'should not run' }; },
        check: async () => ({ outcome: 'not_checked', reason: 'unused' }),
        publish: async () => { throw new Error('unused'); },
      };
      const report = await runLanes({
        db: db(), haltClient: pgHaltClient(db()), lanes: ['trinity-lane-1'], adapters, specs: () => [{ ...spec('belt-runner'), belt: 'research' }], readyTarget: 1,
        publishEnabled: false, checkEnabled: false, idleMs: 1, heartbeatMs: 60_000, maxSteps: 5, log: () => undefined,
      });
      expect(report.errors).toEqual([]);
      expect(calls).toEqual([]);
      expect(report.fenceRefused.some((x) => x.includes('research belt does not cover'))).toBe(true);
    }, 60_000);
  });

  // Gate-0 probe P1, 2026-11-09: with one shared role, a maker set its own submitted row to approved
  // with no check, and the integrator then took it for publishing. Each stage now has its own role,
  // and these attack each one with the writes the others may make. One owner still holds all three
  // credentials: this is separation under one controller, not independent authority.
  describe('separate authority for maker, checker and integrator', () => {
    const asMaker = () => poolDb(worker as never);
    const asChecker = () => poolDb(checker as never);
    const asIntegrator = () => poolDb(integrator as never);
    let n = 0;
    const work = (h: Handle) => ({ branch: `t12/${h.spec.id}-e${h.epoch}`, commit: 'a'.repeat(40), base: 'b'.repeat(40), files: h.spec.paths, host: 'nvidia' });
    const APPROVE = { outcome: 'approved' as const, commit: 'a'.repeat(40), transcript: 'node --test exited 0 and each control exited 1 as it should.', evidence: {} };
    // The P1 probe's own statement, and the same move without touching the verdict column.
    const SELF_APPROVE = `UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"approved"'), verifier_verdict = 'approved' WHERE id = $1`;
    const STAGE_APPROVE = `UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"approved"') WHERE id = $1`;
    /** The SQLSTATE a write ends with, or 'written'. A refusal must carry its code, not just fail. */
    const code = (p: Promise<unknown>) => p.then(() => 'written', (e: { code?: string }) => e.code ?? `no code: ${String(e)}`);
    const retire = (id: number) => admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE id = $1`, [id]);
    const stateOf = async (id: number) => (await readLaneState(admin, id)).state;

    // Earlier blocks leave submitted work in the pool. Retire it, so a claim here can only find this block's rows.
    beforeAll(async () => {
      await admin.query(`UPDATE trinity_tasks SET status = 'cancelled' WHERE assigned_to = $1 AND status <> 'cancelled'`, [LANE_POOL]);
    });

    /** A task the maker has claimed. Top priority, so leftovers in the pool are never picked first. */
    async function claimedBy(lane: string, extra: Partial<LaneSpec> = {}): Promise<Handle> {
      const id = `auth-${++n}`;
      await replenish(asMaker(), [{ ...spec(id), priority: 100, ...extra }], 1000);
      const c = await claimMake(asMaker(), lane);
      if (c.kind !== 'claimed' || c.handle.spec.id !== id) throw new Error(`did not claim ${id}`);
      return c.handle;
    }
    /** A real submission by the maker role, under a live belt, as `lane`. */
    async function submitted(lane = 'trinity-lane-1', extra: Partial<LaneSpec> = {}): Promise<Handle> {
      const h = await claimedBy(lane, extra);
      expect(await checkoutBelt(asMaker(), h)).toMatchObject({ ok: true });
      expect(await submit(asMaker(), h, work(h))).toEqual({ ok: true });
      return h;
    }
    async function approvedBy(lane: string, extra: Partial<LaneSpec> = {}): Promise<Handle> {
      const h = await submitted('trinity-lane-1', extra);
      const v = await claimStage(asChecker(), 'awaiting_check', lane);
      expect(v?.taskId).toBe(h.taskId);
      expect(await recordVerdict(asChecker(), v!, APPROVE)).toEqual({ ok: true });
      return h;
    }

    it('P1 re-run: the maker cannot approve its own submitted row, and refusal is 42501', async () => {
      const h = await submitted();
      expect(await code(worker.query(SELF_APPROVE, [h.taskId]))).toBe('42501');
      expect(await code(worker.query(STAGE_APPROVE, [h.taskId]))).toBe('42501');
      const s = await stateOf(h.taskId);
      expect(s.stage).toBe('awaiting_check');
      expect(s.receipts.filter((r) => r.event === 'check_approved')).toHaveLength(0);
      expect((await admin.query('SELECT verifier_verdict FROM trinity_tasks WHERE id = $1', [h.taskId])).rows[0].verifier_verdict).toBeNull();
      expect(await claimStage(asIntegrator(), 'approved', 'trinity-lane-3')).toBeNull();
      await retire(h.taskId);
    });

    it('the maker cannot record a verdict or move work past awaiting_check, even on a row it holds', async () => {
      const held = await claimedBy('trinity-lane-1');
      for (const sql of [
        `UPDATE trinity_tasks SET verifier_verdict = 'approved' WHERE id = $1`,
        `UPDATE trinity_tasks SET verified_at = now(), verify_count = 1 WHERE id = $1`,
        `UPDATE trinity_tasks SET final_verdict = 'verified_done' WHERE id = $1`,
        `UPDATE trinity_tasks SET completed_at = now() WHERE id = $1`,
        `UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"approved"') WHERE id = $1`,
        `UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"integrating"') WHERE id = $1`,
      ]) expect([sql, await code(worker.query(sql, [held.taskId]))]).toEqual([sql, '42501']);
      // A write that is the maker's own still lands: the refusals above are about what changed.
      expect((await worker.query(`UPDATE trinity_tasks SET stuck_reason = 'probe' WHERE id = $1`, [held.taskId])).rowCount).toBe(1);
      await retire(held.taskId);

      const h = await submitted();
      for (const stage of ['checking', 'approved', 'integrating', 'integrated', 'ready']) {
        const sql = `UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,stage}', '"${stage}"') WHERE id = $1`;
        expect([stage, await code(worker.query(sql, [h.taskId]))]).toEqual([stage, '42501']);
      }
      await retire(h.taskId);
    });

    it('the checker cannot enqueue, check out a belt, make or submit', async () => {
      expect(await code(replenish(asChecker(), [{ ...spec(`auth-${++n}`), priority: 100 }], 1000))).toBe('42501');
      const h = await claimedBy('trinity-lane-1');
      expect(await code(checker.query('SELECT t12_belt_checkout($1, $2, $3)', [h.taskId, h.actor, h.epoch]))).toBe('42501');
      // A live belt exists for this claim, so only the checker's own rules can refuse the submission below.
      expect(await checkoutBelt(asMaker(), h)).toMatchObject({ ok: true });
      const rawSubmit = `UPDATE trinity_tasks SET metadata = jsonb_set(jsonb_set(jsonb_set(metadata, '{t12,submission}', $2::jsonb), '{t12,producer}', to_jsonb(claimed_by)), '{t12,stage}', '"awaiting_check"') WHERE id = $1`;
      expect(await code(checker.query(rawSubmit, [h.taskId, JSON.stringify(work(h))]))).toBe('42501');
      expect(await code(checker.query(`UPDATE trinity_tasks SET expires_at = now() + interval '1 hour' WHERE id = $1`, [h.taskId]))).toBe('42501');
      await releaseMake(asMaker(), h, 'host down', true);
      // A ready row: the checker's claim to make it is refused by Postgres, not only by the runner.
      expect(await code(claimMake(asChecker(), 'trinity-lane-2'))).toBe('42501');
      expect((await stateOf(h.taskId)).stage).toBe('ready');
      await retire(h.taskId);
    });

    it('a checker cannot take or approve work its own lane produced', async () => {
      const h = await submitted('trinity-lane-2');
      expect((await stateOf(h.taskId)).producer).toBe('trinity-lane-2');
      // The store never offers it...
      expect(await claimStage(asChecker(), 'awaiting_check', 'trinity-lane-2')).toBeNull();
      // ...and Postgres refuses the claim written straight to the row.
      const takeAs = (lane: string) => checker.query(
        `UPDATE trinity_tasks SET claimed_by = $2, claimed_at = now(), metadata = jsonb_set(metadata, '{t12,stage}', '"checking"') WHERE id = $1`, [h.taskId, lane],
      );
      expect(await code(takeAs('trinity-lane-2'))).toBe('42501');
      // Even if the row reached checking held by its producer some other way, the approval is refused.
      await admin.query(`UPDATE trinity_tasks SET claimed_by = 'trinity-lane-2', claimed_at = now(), metadata = jsonb_set(metadata, '{t12,stage}', '"checking"') WHERE id = $1`, [h.taskId]);
      const s = await stateOf(h.taskId);
      const own: Handle = { taskId: h.taskId, actor: 'trinity-lane-2', epoch: s.epoch, spec: s.spec, attempts: s.attempts, submission: s.submission };
      expect(await code(recordVerdict(asChecker(), own, APPROVE))).toBe('42501');
      expect((await stateOf(h.taskId)).stage).toBe('checking');
      // Positive control: the same raw claim, by a lane that did not produce the work, is accepted.
      await admin.query(`UPDATE trinity_tasks SET claimed_by = NULL, claimed_at = NULL, metadata = jsonb_set(metadata, '{t12,stage}', '"awaiting_check"') WHERE id = $1`, [h.taskId]);
      expect((await takeAs('trinity-lane-4')).rowCount).toBe(1);
      // And the checker cannot rewrite who produced it.
      expect(await code(checker.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,producer}', '"trinity-lane-9"') WHERE id = $1`, [h.taskId]))).toBe('42501');
      await retire(h.taskId);
    });

    it('the integrator cannot approve, and cannot take HIGH risk work', async () => {
      const h = await submitted();
      expect(await code(integrator.query(SELF_APPROVE, [h.taskId]))).toBe('42501');
      expect(await code(integrator.query(STAGE_APPROVE, [h.taskId]))).toBe('42501');
      const v = await claimStage(asChecker(), 'awaiting_check', 'trinity-lane-2');
      expect(v?.taskId).toBe(h.taskId);
      expect(await code(integrator.query(SELF_APPROVE, [h.taskId]))).toBe('42501');
      expect(await code(integrator.query(STAGE_APPROVE, [h.taskId]))).toBe('42501');
      expect(await code(integrator.query(`UPDATE trinity_tasks SET verifier_verdict = 'approved' WHERE id = $1`, [h.taskId]))).toBe('42501');
      await retire(h.taskId);

      const hi = await approvedBy('trinity-lane-2', { risk: 'HIGH' });
      expect(await claimStage(asIntegrator(), 'approved', 'trinity-lane-3')).toBeNull();
      expect(await code(integrator.query(
        `UPDATE trinity_tasks SET claimed_by = 'trinity-lane-3', claimed_at = now(), metadata = jsonb_set(metadata, '{t12,stage}', '"integrating"') WHERE id = $1`, [hi.taskId],
      ))).toBe('42501');
      await retire(hi.taskId);
    });

    it('each role hands back only its own stage, and the integrator only to where the row came from', async () => {
      const h = await approvedBy('trinity-lane-2');
      const i = await claimStage(asIntegrator(), 'approved', 'trinity-lane-3');
      expect(i?.taskId).toBe(h.taskId);
      expect(await code(recoverStages(asChecker(), 0, ['integrating']))).toBe('42501');
      expect(await code(recoverStages(asMaker(), 0, ['integrating']))).toBe('42501');
      expect(await recoverStages(asIntegrator(), 0, ['integrating'])).toBe(1);
      expect((await stateOf(h.taskId)).stage).toBe('approved');
      await retire(h.taskId);
    });

    it('the retired shared role cannot log in and holds nothing on the pool', async () => {
      expect((await admin.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 't12_lane_worker'`)).rows[0]).toEqual({ rolcanlogin: false });
      const u = new URL(workerUrl);
      u.username = 't12_lane_worker';
      const c = new Client({ connectionString: u.toString() });
      await expect(c.connect()).rejects.toThrow(/not permitted to log in/);
      const { rows } = await admin.query(
        `SELECT has_table_privilege('t12_lane_worker', 'public.trinity_tasks', 'SELECT') AS sel,
                has_any_column_privilege('t12_lane_worker', 'public.trinity_tasks', 'UPDATE') AS upd,
                has_function_privilege('t12_lane_worker', 'public.t12_belt_checkout(bigint, text, integer)', 'EXECUTE') AS belt`,
      );
      expect(rows[0]).toEqual({ sel: false, upd: false, belt: false });
    });

    it('mutation control: with the shared role\'s check back on the maker, the P1 attack lands', async () => {
      // If the P1 test above could not fail, this would be refused too.
      await admin.query('GRANT EXECUTE ON FUNCTION public.t12_belt_permits(bigint, jsonb) TO t12_lane_maker');
      await admin.query(`ALTER POLICY t12_lane_maker_pool ON trinity_tasks WITH CHECK (
        assigned_to = 'trinity-t12-lanes' AND public.t12_belt_permits(id, metadata)
        AND status IN ('pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked'))`);
      try {
        const h = await submitted();
        expect((await worker.query(SELF_APPROVE, [h.taskId])).rowCount).toBe(1);
        expect((await claimStage(asIntegrator(), 'approved', 'trinity-lane-3'))?.taskId).toBe(h.taskId);
        await retire(h.taskId);
      } finally {
        await admin.query(readFileSync(MIGRATION, 'utf8'));
      }
      const again = await submitted();
      expect(await code(worker.query(SELF_APPROVE, [again.taskId]))).toBe('42501');
      await retire(again.taskId);
    });
  });

  it('the real CLI starts as this role and refuses a role that can bypass row security', () => {
    const dir = mkdtempSync(join(tmpdir(), 't12-prof-'));
    try {
      const specs = join(dir, 's.jsonl');
      writeFileSync(specs, '');
      const args = ['--specs', specs, '--repo', `DealAppSeo/trustshell=${dir}`, '--work-root', join(dir, 'w'), '--lanes', '1'];
      const asOwner = cli(args, { T12_LANES_ENABLED: 'true', DATABASE_URL: workerUrl.replace('t12_lane_maker', 'postgres') });
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
