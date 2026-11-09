/**
 * The T12 supervisor end to end, on synthetic everything: throwaway Postgres under the restricted role, a
 * loopback model, real git, the real CLI per role, three separate clones and real SIGKILLs. A check runs
 * in the real container, so the approving path needs Docker. Role fences do not, and always run.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client, Pool } from 'pg';
import { buildDailyRecord } from '../src/orchestration/t12-daily-record';
import { bundleName } from '../src/orchestration/t12-lane-transfer';
import { verifyReceipts, type DecisionReceipt, type LaneState } from '../src/orchestration/t12-lane-store';

const ROOT = join(__dirname, '..');
const PG = process.env.T12_LANES_PG_URL;
const DOCKER = process.platform === 'linux' && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const describeFull = PG && DOCKER ? describe : describe.skip;
if (!PG || !DOCKER) {
  // eslint-disable-next-line no-console
  console.warn('[t12-supervisor-e2e] NOT_CHECKED: the full proof needs T12_LANES_PG_URL and Docker on Linux. A skip here is not a pass.');
}

type Role = 'maker' | 'checker' | 'integrator';
const DB = 't12_supervisor_e2e';
const REPO = 'DealAppSeo/trustshell';
const PASS = (name: string) => `import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/thing.mjs';\ntest('${name}', () => assert.equal(answer(), 42));\n`;
const spec = (id: string) => ({ id, repo: REPO, title: `task ${id}`, prompt: 'Add a focused regression test.', paths: [`tests/${id}.test.mjs`], verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: [{ file: 'src/thing.mjs', find: '42', replace: '41' }] }, risk: 'LOW', priority: 50 });

const cli = (args: string[], env: NodeJS.ProcessEnv) => spawn(process.execPath, ['node_modules/ts-node/dist/bin.js', '--transpile-only', 'scripts/t12/lanes.ts', ...args], { cwd: ROOT, env });
const collect = (child: ChildProcess) => {
  let out = ''; let err = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { err += d; });
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on('close', (code) => resolve({ code, out, err })));
};
const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '' });

describe('a role refuses credentials it should not hold', () => {
  const run = async (role: Role, extra: NodeJS.ProcessEnv) => collect(cli(['--role', role, '--specs', 'x', '--work-root', 'y'], { ...baseEnv(), T12_LANES_ENABLED: 'true', ...extra }));
  it.each<[string, Role, NodeJS.ProcessEnv, string]>([
    ['a maker allowed to run code', 'maker', { T12_LANES_ALLOW_EXEC: 'true' }, 'must not be allowed to run code'],
    ['a maker allowed to publish', 'maker', { T12_LANES_PUBLISH: 'true' }, 'must not publish'],
    ['a checker holding a model key', 'checker', { T12_LANES_ALLOW_EXEC: 'true', GROQ_API_KEY: 'k' }, 'must not hold model keys'],
    ['a checker that may publish', 'checker', { T12_LANES_PUBLISH: 'true', T12_LANES_ALLOW_EXEC: 'true' }, 'NOT_CHECKED'],
    ['an integrator allowed to run code', 'integrator', { T12_LANES_PUBLISH: 'true', T12_LANES_ALLOW_EXEC: 'true' }, 'NOT_CHECKED'],
    ['an integrator holding a model key', 'integrator', { T12_LANES_PUBLISH: 'true', GROQ_API_KEY: 'k' }, 'must not hold model keys'],
  ])('%s exits NOT_CHECKED before touching anything', async (_name, role, extra, says) => {
    const r = await run(role, extra);
    expect(r.code).toBe(2);
    expect(r.err).toContain(says);
  }, 60_000);

  it('an unknown role is refused', async () => {
    const r = await collect(cli(['--role', 'admin'], { ...baseEnv(), T12_LANES_ENABLED: 'true' }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('--role must be');
  }, 60_000);
});

describeFull('three roles on three clones', () => {
  let root: string; let origin: string; let admin: Pool; let workerUrl: string; let server: Server; let port: number; let transfer: string; let fakeBin: string;
  const calls: string[] = [];
  const held = new Map<string, () => void>();
  const hold = (id: string) => new Promise<void>((resolve) => held.set(id, resolve));
  let holdIds = new Set<string>();
  const clones: Record<Role, string> = { maker: '', checker: '', integrator: '' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeAll(async () => {
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${DB}`);
    await c.end();
    const u = new URL(PG!);
    u.pathname = `/${DB}`;
    admin = new Pool({ connectionString: u.toString() });
    await admin.query(readFileSync(join(__dirname, 'fixtures/t12-lanes-schema.sql'), 'utf8'));
    await admin.query(readFileSync(join(ROOT, 'migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8'));
    u.username = 't12_lane_worker';
    workerUrl = u.toString();

    root = realpathSync(mkdtempSync(join(tmpdir(), 't12-e2e-')));
    origin = join(root, 'origin.git');
    transfer = join(root, 'transfer');
    mkdirSync(transfer);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = join(root, 'seed');
    execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
    git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't'); git(seed, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(seed, 'src'));
    writeFileSync(join(seed, 'src/thing.mjs'), 'export const answer = () => 42;\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'push', '-q', 'origin', 'main');
    for (const role of ['maker', 'checker', 'integrator'] as Role[]) {
      clones[role] = join(root, `clone-${role}`);
      execFileSync('git', ['clone', '-q', origin, clones[role]], { stdio: 'ignore' });
    }

    // Stands in for GitHub's CLI. Nothing here can reach GitHub.
    fakeBin = join(root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\ncase "$2" in list) echo "" ;; create) echo "https://example.test/pr/1" ;; esac\n');
    chmodSync(join(fakeBin, 'gh'), 0o755);

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        const prompt: string = JSON.parse(body).messages[0].content;
        const id = /Write exactly these files: tests\/([a-z0-9-]+)\.test\.mjs/.exec(prompt)![1]!;
        calls.push(id);
        if (holdIds.has(id)) await hold(id);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ files: [{ path: `tests/${id}.test.mjs`, content: PASS(id) }] }) } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    for (const release of held.values()) release();
    await new Promise((r) => server.close(r));
    if (process.env.T12_E2E_RECORD_OUT) {
      const { rows } = await admin.query(`SELECT metadata -> 't12' AS state FROM trinity_tasks WHERE metadata ? 't12'`);
      writeFileSync(process.env.T12_E2E_RECORD_OUT, `${JSON.stringify(buildDailyRecord(rows, new Date().toISOString().slice(0, 10), 'synthetic'), null, 2)}\n`);
    }
    await admin.end();
    rmSync(root, { recursive: true, force: true });
  });

  function start(role: Role, id: string, lane: string, wake = 'scheduled') {
    const specsFile = join(root, `specs-${id}.jsonl`);
    writeFileSync(specsFile, JSON.stringify(spec(id)));
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(), DATABASE_URL: workerUrl, T12_LANES_ENABLED: 'true',
      ...(role === 'maker' ? { T12_FREE_WAVE: 'true', T12_LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1` } : {}),
      ...(role === 'checker' ? { T12_LANES_ALLOW_EXEC: 'true' } : {}),
      ...(role === 'integrator' ? { T12_LANES_PUBLISH: 'true', PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` } : {}),
    };
    const transferArgs = role === 'maker' ? ['--transfer-out', transfer] : ['--transfer-in', transfer];
    const child = cli(['--role', role, '--lane-name', lane, '--wake', wake, '--specs', specsFile, '--repo', `${REPO}=${clones[role]}`, '--work-root', join(root, `w-${role}-${lane}`), '--ready-target', '1', ...transferArgs], env);
    return { child, done: collect(child) };
  }
  const report = (r: { out: string; err: string }) => {
    const at = r.out.indexOf('{\n');
    if (at === -1) throw new Error(`no report: ${r.err.slice(-600)}`);
    return JSON.parse(r.out.slice(at));
  };
  const state = async (id: string): Promise<{ status: string; claimed_by: string | null; s: LaneState }> => {
    const { rows } = await admin.query(`SELECT status, claimed_by, metadata #> '{t12}' AS s FROM trinity_tasks WHERE metadata #>> '{t12,spec,id}' = $1`, [id]);
    return { status: rows[0]?.status, claimed_by: rows[0]?.claimed_by, s: rows[0]?.s };
  };
  async function until(what: string, check: () => Promise<boolean>, ms = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('maker, checker and integrator each do only their stage, and the commit moves only by verified bundle', async () => {
    const m = report(await start('maker', 'one', 'trinity-lane-1').done);
    expect(m).toMatchObject({ made: 1, approved: 0, integrated: 0, errors: [] });
    const sub = (await state('one')).s.submission!;
    expect(sub.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(transfer, bundleName('one', sub.commit)))).toBe(true);
    for (const role of ['checker', 'integrator'] as Role[]) expect(() => git(clones[role], 'cat-file', '-e', `${sub.commit}^{commit}`)).toThrow();

    const c = report(await start('checker', 'one', 'trinity-lane-2').done);
    expect(c).toMatchObject({ made: 0, approved: 1, integrated: 0, errors: [] });
    expect(git(clones.checker, 'cat-file', '-t', sub.commit)).toBe('commit');

    const i = report(await start('integrator', 'one', 'trinity-lane-3').done);
    expect(i).toMatchObject({ made: 0, approved: 0, integrated: 1, errors: [] });
    expect(git(origin, 'rev-parse', `refs/heads/${sub.branch}`)).toBe(sub.commit);

    const { s } = await state('one');
    expect(s.stage).toBe('integrated');
    expect(verifyReceipts(s.receipts).ok).toBe(true);
    const actor = (event: string) => s.receipts.find((r: DecisionReceipt) => r.event === event)!.actor;
    expect(new Set([actor('submitted'), actor('check_approved'), actor('integrated')]).size).toBe(3);
    expect(s.receipts.find((r: DecisionReceipt) => r.event === 'check_approved')!.evidence).toMatchObject({ independence: 'same_controller_rerun' });
    expect(calls.filter((x) => x === 'one')).toHaveLength(1);
  }, 300_000);

  it('a bundle changed after submission is refused before anything runs', async () => {
    report(await start('maker', 'tampered', 'trinity-lane-1').done);
    const sub = (await state('tampered')).s.submission!;
    const file = join(transfer, bundleName('tampered', sub.commit));
    const b = readFileSync(file);
    b[b.length - 1] = b[b.length - 1]! ^ 0xff;
    writeFileSync(file, b);
    const c = report(await start('checker', 'tampered', 'trinity-lane-2').done);
    expect(c).toMatchObject({ approved: 0, rejected: 1 });
    const { s } = await state('tampered');
    expect(s.lastRejection).toContain('digest');
    expect(() => git(clones.checker, 'cat-file', '-e', `${sub.commit}^{commit}`)).toThrow();
  }, 240_000);

  it('a duplicate wake leaves, a killed maker is recovered, and the work finishes once', async () => {
    holdIds = new Set(['crash']);
    const first = start('maker', 'crash', 'trinity-lane-1');
    await until('the model call', async () => calls.includes('crash'));

    const dup = report(await start('maker', 'crash', 'trinity-lane-1').done);
    expect(dup).toMatchObject({ duplicateWakes: ['trinity-lane-1'], made: 0 });
    expect(calls.filter((x) => x === 'crash')).toHaveLength(1);

    first.child.kill('SIGKILL');
    await first.done;
    expect((await state('crash')).status).toBe('claimed');

    await admin.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE metadata #>> '{t12,spec,id}' = 'crash'`);
    expect((await admin.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n).toBe(1);
    await admin.query(`UPDATE agent_resource_claims SET expires_at = now() - interval '1 second', claimed_at = now() - interval '1 hour' WHERE resource_id = 'lane_wake:trinity-lane-1'`);
    holdIds = new Set();
    held.get('crash')?.();

    expect(report(await start('maker', 'crash', 'trinity-lane-1').done)).toMatchObject({ made: 1, errors: [] });
    expect(report(await start('checker', 'crash', 'trinity-lane-2').done)).toMatchObject({ approved: 1 });
    const { s } = await state('crash');
    expect(s.stage).toBe('approved');
    expect(s.receipts.filter((r: DecisionReceipt) => r.event === 'lease_reaped')).toHaveLength(1);
    expect(s.receipts.filter((r: DecisionReceipt) => r.event === 'submitted')).toHaveLength(1);
    expect(verifyReceipts(s.receipts).ok).toBe(true);
  }, 300_000);

  it('the emergency halt stops every role before any work and any model call', async () => {
    await admin.query('UPDATE trinity_system_config SET emergency_halt = true WHERE id = 1');
    const before = calls.length;
    try {
      const m = report(await start('maker', 'halted', 'trinity-lane-1').done);
      expect(m).toMatchObject({ stoppedBy: 'emergency_halt', made: 0 });
      expect(report(await start('checker', 'halted', 'trinity-lane-2').done)).toMatchObject({ stoppedBy: 'emergency_halt', approved: 0 });
      expect(calls.length).toBe(before);
      expect(await state('halted')).toMatchObject({ status: undefined });
    } finally {
      await admin.query('UPDATE trinity_system_config SET emergency_halt = false WHERE id = 1');
    }
  }, 180_000);

  it('the worker role cannot lift the halt', async () => {
    const worker = new Client({ connectionString: workerUrl });
    await worker.connect();
    try {
      await expect(worker.query('UPDATE trinity_system_config SET emergency_halt = false WHERE id = 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await worker.end();
    }
  }, 30_000);
});
