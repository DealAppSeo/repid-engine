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
import { runLanes, type LaneAdapters } from '../src/orchestration/t12-lane-runner';
import {
  LANE_POOL, checkoutBelt, claimMake, claimStage, coolProvider, coolingProviders, pgHaltClient, poolDb, readLaneState, recordIntegration, recordVerdict, releaseMake, replenish, submit,
  type Handle, type LaneSpec,
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
    expect(await checkoutBelt(db, c.handle)).toMatchObject({ ok: true, belt: 'engineering' });
    expect(await submit(db, c.handle, { branch: 'b', commit: 'c1', base: 'b0', files: c.handle.spec.paths, host: 'nvidia' })).toEqual({ ok: true });
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
    const work = (h: Handle, files = h.spec.paths) => ({ branch: 'b', commit: 'c1', base: 'b0', files, host: 'nvidia' });
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

    it('holds no role or membership that reaches past the policy', async () => {
      const { rows } = await worker.query(`SELECT r.rolname FROM pg_roles r WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'member')`);
      expect(rows).toEqual([]);
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
