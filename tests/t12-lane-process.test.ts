/**
 * The durable conductor as real, separate operating-system processes: the actual CLI for each
 * lane, the restricted database role, real git, real test runs, and a real SIGKILL mid-task. Only
 * the model is replaced, by a loopback server, because the point here is the machinery.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { verifyReceipts, type DecisionReceipt, type LaneState } from '../src/orchestration/t12-lane-store';

const PG = process.env.T12_LANES_PG_URL;
// A check now runs only in a container, so approvals need Docker too.
const DOCKER = process.platform === 'linux' && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const describePg = PG && DOCKER ? describe : describe.skip;
if (!PG || !DOCKER) {
  // eslint-disable-next-line no-console
  console.warn('[t12-lane-process] NOT_CHECKED: this proof needs T12_LANES_PG_URL (a throwaway Postgres) and Docker on Linux.');
}
const ROOT = join(__dirname, '..');
const DB = 't12_process_test';
const PASS = (name: string) => `import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/thing.mjs';\ntest('${name}', () => assert.equal(answer(), 42));\n`;
const CONTROL = [{ file: 'src/thing.mjs', find: '42', replace: '41' }];
const spec = (id: string, priority: number) => ({
  id, repo: 'DealAppSeo/trustshell', title: `task ${id}`, prompt: 'Add a focused regression test for the behaviour described in this task.',
  paths: [`tests/${id}.test.mjs`], verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: CONTROL }, risk: 'LOW', priority,
});

describePg('three real worker processes', () => {
  let root: string;
  let admin: Pool;
  let workerUrl: string;
  let server: Server;
  let port: number;
  let release: () => void = () => {};
  let held = new Promise<void>((resolve) => { release = resolve; });
  let specsFile: string;
  const calls: string[] = [];

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

    root = mkdtempSync(join(tmpdir(), 't12-proc-'));
    const origin = join(root, 'origin.git');
    const canon = join(root, 'canon');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, canon], { stdio: 'ignore' });
    git(canon, 'config', 'user.email', 't@t');
    git(canon, 'config', 'user.name', 't');
    git(canon, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(canon, 'src'));
    writeFileSync(join(canon, 'src/thing.mjs'), 'export const answer = () => 42;\n');
    git(canon, 'add', '.');
    git(canon, 'commit', '-q', '-m', 'seed');
    git(canon, 'push', '-q', 'origin', 'main');

    specsFile = join(root, 'specs.jsonl');
    writeFileSync(specsFile, [spec('c1', 90), spec('c2', 80), spec('c3', 70)].map((s) => JSON.stringify(s)).join('\n'));

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        const prompt: string = JSON.parse(body).messages[0].content;
        const id = /Write exactly these files: tests\/(c\d)\.test\.mjs/.exec(prompt)![1]!;
        calls.push(id);
        if (id === 'c1') await held;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ files: [{ path: `tests/${id}.test.mjs`, content: PASS(id) }] }) } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    release();
    await new Promise((resolve) => server.close(resolve));
    await admin.end();
    rmSync(root, { recursive: true, force: true });
  });

  function start(lane: string, wake: 'human_prompt' | 'scheduled'): { child: ChildProcess; done: Promise<{ code: number | null; out: string; err: string }> } {
    const child = spawn(process.execPath, [
      'node_modules/ts-node/dist/bin.js', '--transpile-only', 'scripts/t12/lanes.ts',
      '--lane-name', lane, '--wake', wake, '--specs', specsFile, '--repo', `DealAppSeo/trustshell=${join(root, 'canon')}`, '--work-root', join(root, `w-${lane}`), '--ready-target', '3',
    ], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', USERPROFILE: process.env.USERPROFILE ?? '',
        DATABASE_URL: workerUrl, T12_LANES_ENABLED: 'true', T12_FREE_WAVE: 'true', T12_LANES_ALLOW_EXEC: 'true', T12_LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`,
      },
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    return { child, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err }))) };
  }
  const report = (r: { out: string; err: string }) => {
    const at = r.out.indexOf('{\n');
    if (at === -1) throw new Error(`no report: ${r.err.slice(-400)}`);
    return JSON.parse(r.out.slice(at));
  };
  const state = async (id: string): Promise<{ status: string; claimed_by: string | null; s: LaneState }> => {
    const { rows } = await admin.query(`SELECT status, claimed_by, metadata #> '{t12}' AS s FROM trinity_tasks WHERE metadata #>> '{t12,spec,id}' = $1`, [id]);
    return { status: rows[0]?.status, claimed_by: rows[0]?.claimed_by, s: rows[0]?.s };
  };
  async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('claims atomically, refuses a duplicate wake, survives SIGKILL, and finishes everything', async () => {
    // Lane 1 refills the queue by itself and takes the top task, which hangs at the model.
    const l1 = start('trinity-lane-1', 'human_prompt');
    await until('c1 to be claimed', async () => (await state('c1')).status === 'claimed' && calls.includes('c1'));
    expect((await state('c1')).claimed_by).toBe('trinity-lane-1');

    // Two more processes take the other tasks at the same time.
    const [l2, l3] = [start('trinity-lane-2', 'human_prompt'), start('trinity-lane-3', 'human_prompt')];

    // A second wake of a lane that is already running leaves without doing anything.
    const dup = await start('trinity-lane-1', 'scheduled').done;
    expect(report(dup)).toMatchObject({ duplicateWakes: ['trinity-lane-1'], made: 0, approved: 0 });

    const [r2, r3] = await Promise.all([l2.done, l3.done]);
    expect(report(r2).errors).toEqual([]);
    expect(report(r3).errors).toEqual([]);
    expect(report(r2).made + report(r3).made).toBe(2);

    // Kill the lane mid-task, without warning.
    l1.child.kill('SIGKILL');
    await l1.done;
    expect((await state('c1')).status).toBe('claimed');

    // The production cron frees the lease; the wake slot lapses on its own timer in production.
    await admin.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE metadata #>> '{t12,spec,id}' = 'c1'`);
    expect((await admin.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n).toBe(1);
    await admin.query(`UPDATE agent_resource_claims SET expires_at = now() - interval '1 second', claimed_at = now() - interval '1 hour' WHERE resource_id = 'lane_wake:trinity-lane-1'`);
    release();

    // A fresh process takes over from durable state alone.
    expect(report(await start('trinity-lane-1', 'scheduled').done).errors).toEqual([]);
    await Promise.all([start('trinity-lane-2', 'scheduled').done, start('trinity-lane-3', 'scheduled').done]);

    for (const id of ['c1', 'c2', 'c3']) {
      const { status, s } = await state(id);
      expect({ id, status, stage: s.stage }).toEqual({ id, status: 'pending_validation', stage: 'approved' });
      const maker = s.receipts.find((r: DecisionReceipt) => r.event === 'submitted')!.actor;
      const checker = s.receipts.find((r: DecisionReceipt) => r.event === 'check_approved')!.actor;
      expect(checker).not.toBe(maker);
      expect(verifyReceipts(s.receipts).ok).toBe(true);
      expect(git(join(root, 'canon'), 'cat-file', '-t', s.submission!.commit)).toBe('commit');
    }

    // Every decision says why it happened.
    const c1 = (await state('c1')).s.receipts;
    const of = (event: string) => c1.filter((r) => r.event === event).map((r) => r.origin);
    expect(of('enqueued')).toEqual(['autonomous']);
    expect(of('lease_reaped')).toEqual(['recovery']);
    expect(of('claimed')[0]).toBe('human_prompt');
    expect(of('claimed').at(-1)).toBe('scheduled');
    expect(c1.filter((r) => r.event === 'claimed').map((r) => r.actor)).toEqual(['trinity-lane-1', 'trinity-lane-1']);
    expect(c1.filter((r) => r.event === 'claimed').map((r) => r.epoch)).toEqual([1, 2]);

    // The killed attempt's model call and the fresh one, and exactly one each for the others.
    expect(calls.filter((x) => x === 'c2')).toHaveLength(1);
    expect(calls.filter((x) => x === 'c3')).toHaveLength(1);
    expect(calls.filter((x) => x === 'c1')).toHaveLength(2);
  }, 240_000);
});
