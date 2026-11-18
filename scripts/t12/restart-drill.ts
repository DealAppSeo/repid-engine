/**
 * restart-drill.ts — drive the REAL T12 lane store on a THROWAWAY Postgres through the five things
 * a durable dispatch loop must survive, one PASS/FAIL line each:
 *   1 RESTART          a claim survives its process dying; a new process with only the task id finishes it
 *   2 STALE LEASE      an expired lease goes back to ready, another worker takes it, the first is fenced
 *   3 DUPLICATE        the owner submits twice and an old attempt once: exactly one result recorded
 *   4 PROVIDER OUTAGE  a provider cools, the task goes back blameless, a fallback ticket is claimed
 *   5 OPERATOR GATE    a Sean-only gate keeps a ticket unclaimable, names the action, other work goes on
 * Steps 2 and 3 also run a NEGATIVE CONTROL: the same assertions against a test double that blinds
 * the store's fence (it lies about the locked row). Those must come out FAIL, or the PASS proves nothing.
 *
 * Run (PowerShell), against a throwaway database ONLY:
 *   $env:T12_LANES_PG_URL = "postgres://postgres@127.0.0.1:55432/postgres"
 *   $env:SUPABASE_URL = "http://localhost:54321"; $env:SUPABASE_SERVICE_KEY = "dummy"
 *   npx ts-node --transpile-only scripts/t12/restart-drill.ts
 * The drill DROPS and recreates the lane tables. It refuses any non-loopback host.
 * It is not scheduled and flips no flag.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  claimMake, claimStage, coolProvider, coolingProviders, heartbeat, poolDb, readLaneState, recordRouteAttempt, recordVerdict,
  replenish, submit, verifyReceipts, waitForCapacity, type Handle, type LaneSpec, type SqlRunner, type Submission, type TxDb,
} from '../../src/orchestration/t12-lane-store';
import { checkPacket, partitionForEnqueue, type TaskPacket } from '../../src/orchestration/dispatch-packet';

const ROOT = join(__dirname, '..', '..');
const URL_ = process.env.T12_LANES_PG_URL ?? '';
const L1 = 'trinity-lane-1';
const L2 = 'trinity-lane-2';
const CHECKER = 'trinity-lane-checker';
const FORBIDDEN = ['done', 'verified', 'shadow_reject'];
const NOW = () => new Date();

function assertThrowaway(url: string): void {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through */ }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`refusing to run: T12_LANES_PG_URL must point at a loopback throwaway Postgres (got host "${host || 'unparseable'}")`);
  }
}

const basePacket = (): TaskPacket => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/dispatch-packet-example.json'), 'utf8'));
type DrillSpec = LaneSpec & { packet: TaskPacket };
const CONTROL = [{ file: 'src/thing.mjs', find: '42', replace: '41' }];
function spec(id: string, over: Partial<LaneSpec> = {}, packet: TaskPacket = { ...basePacket(), task_id: id }): DrillSpec {
  return {
    id, repo: 'DealAppSeo/t12-dogfood-sandbox', title: `drill ${id}`,
    prompt: 'Add a focused regression test for the behaviour this drill ticket describes.',
    paths: [`tests/${id}.test.mjs`], verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: CONTROL }, risk: 'LOW',
    packet, ...over,
  };
}
const sha = (c: string) => c.repeat(40).slice(0, 40);
const sub = (id: string, c: string): Submission => ({ branch: `t12/${id}-e1`, commit: sha(c), base: sha('b'), files: [`tests/${id}.test.mjs`], host: 'drill' });

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query(readFileSync(join(ROOT, 'tests/fixtures/t12-lanes-schema.sql'), 'utf8'));
  await pool.query(readFileSync(join(ROOT, 'migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8'));
  // Every status ever written, so "zero rows ever in done/verified/shadow_reject" is a measurement, not a snapshot.
  await pool.query(`
    DROP TABLE IF EXISTS drill_status_seen;
    CREATE TABLE drill_status_seen (task_id bigint, status text, at timestamptz DEFAULT clock_timestamp());
    CREATE OR REPLACE FUNCTION drill_seen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO drill_status_seen (task_id, status) VALUES (NEW.id, NEW.status); RETURN NEW; END $$;
    CREATE TRIGGER drill_seen AFTER INSERT OR UPDATE ON trinity_tasks FOR EACH ROW EXECUTE FUNCTION drill_seen();`);
}
const truncate = (pool: Pool) => pool.query('TRUNCATE trinity_tasks RESTART IDENTITY; TRUNCATE agent_resource_claims RESTART IDENTITY');

/**
 * NEGATIVE-CONTROL DOUBLE. Wraps a TxDb and rewrites the row the store locks before fencing, so the
 * fence sees `h` as the live owner in `making`. The store is not edited; its input is forged.
 */
function fenceBlindDb(db: TxDb, h: Handle): TxDb {
  const blind = (c: SqlRunner): SqlRunner => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      if (/FOR UPDATE/.test(sql) && /WHERE id = \$1 AND assigned_to = \$3/.test(sql) && r.rows[0]) {
        const row = r.rows[0];
        row.status = 'claimed';
        row.claimed_by = h.actor;
        row.lease_live = true;
        row.age_ok = true;
        row.metadata = { ...row.metadata, t12: { ...row.metadata.t12, epoch: h.epoch, stage: 'making' } };
      }
      return r;
    },
  });
  return { query: db.query, tx: (fn) => db.tx((c) => fn(blind(c))) };
}

type Line = { ok: boolean; detail: string };
const pass = (detail: string): Line => ({ ok: true, detail });
const fail = (detail: string): Line => ({ ok: false, detail });

async function chainsOk(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query('SELECT id, metadata FROM trinity_tasks WHERE metadata ? $1', ['t12']);
  for (const r of rows) {
    const v = verifyReceipts(r.metadata.t12.receipts);
    if (!v.ok) return `receipt chain of task ${r.id} broken at ${v.brokenAt}`;
  }
  return null;
}

async function claimed(db: TxDb, lane: string): Promise<Handle> {
  const c = await claimMake(db, lane);
  if (c.kind !== 'claimed') throw new Error(`expected a claim for ${lane}, got ${c.kind}: ${c.reason}`);
  return c.handle;
}

/** The child process for step 1: claim, checkpoint, heartbeat, then exit without releasing anything. */
async function childClaim(): Promise<void> {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const db = poolDb(pool as never);
  const h = await claimed(db, L1);
  const cp = await recordRouteAttempt(db, h, { host: 'checkpoint', model: 'drill', status: null, reason: 'checkpoint: draft written, tests not yet run' }, null);
  const hb = await heartbeat(db, h);
  if (!cp.ok || !hb.ok) throw new Error(`child could not checkpoint/heartbeat: ${JSON.stringify({ cp, hb })}`);
  process.stdout.write(JSON.stringify({ taskId: h.taskId, pid: process.pid }) + '\n');
  await pool.end();
}

/** What a new process does with nothing but a task id: rebuild the handle from the stored row. */
async function resumeFromRow(db: TxDb, taskId: number) {
  const { status, claimed_by, state } = await readLaneState(db, taskId);
  if (status !== 'claimed' || !claimed_by || state.stage !== 'making') return { problem: `row is ${status}/${state.stage}, nothing to resume` } as const;
  const handle: Handle = { taskId, actor: claimed_by, epoch: state.epoch, spec: state.spec, attempts: state.attempts, lastRejection: state.lastRejection };
  const packet = (state.spec as DrillSpec).packet;
  const checkpoint = [...state.receipts].reverse().find((r) => r.event === 'route_attempt' && (r.evidence as { provider?: string })?.provider === 'checkpoint');
  return { handle, packet, checkpoint, receipts: state.receipts } as const;
}

async function step1Restart(db: TxDb, pool: Pool): Promise<Line> {
  await replenish(db, [spec('restart-1')], 1);
  const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--phase=claim'], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (child.status !== 0) return fail(`child claim process failed: ${child.stderr.slice(-400)}`);
  const { taskId, pid } = JSON.parse(child.stdout.trim().split('\n').pop()!);
  if (pid === process.pid) return fail('child ran in this process: state was not thrown away');
  const r = await resumeFromRow(db, taskId);
  if ('problem' in r) return fail(r.problem!);
  const pc = checkPacket(r.packet, NOW());
  if (!pc.ok) return fail(`stored packet does not validate: ${pc.problems.join('; ')}`);
  if (!r.checkpoint) return fail('no checkpoint receipt on the stored row');
  const hb = await heartbeat(db, r.handle);
  if (!hb.ok) return fail(`resumed heartbeat refused: ${hb.reason}`);
  const s = await submit(db, r.handle, sub('restart-1', 'a'));
  if (!s.ok) return fail(`resumed submit refused: ${s.reason}`);
  const check = await claimStage(db, 'awaiting_check', CHECKER);
  if (!check) return fail('no independent checker could claim the submission');
  const v = await recordVerdict(db, check, { outcome: 'approved', commit: check.submission!.commit, transcript: 'drill: node --test exited 0; with the control applied it exited 1', evidence: { exit: 0 } });
  if (!v.ok) return fail(`verdict refused: ${v.reason}`);
  const end = await readLaneState(db, taskId);
  if (end.state.stage !== 'approved') return fail(`ended at ${end.state.stage}, expected approved`);
  return pass(`child pid ${pid} claimed task ${taskId} and exited; this process (pid ${process.pid}) rebuilt the handle from the row (epoch ${r.handle.epoch}, packet valid, checkpoint "${r.checkpoint.reason}"), heartbeat ok, submitted, independently checked -> ${end.state.stage}; receipts ${end.state.receipts.map((x) => x.event).join('>')}`);
}

async function step2Stale(db: TxDb, pool: Pool, blindFirst: boolean): Promise<Line> {
  await truncate(pool);
  await replenish(db, [spec('stale-2')], 1);
  const first = await claimed(db, L1);
  await pool.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE id = $1`, [first.taskId]); // throwaway DB: age the lease
  const reaped = (await pool.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n;
  const back = await readLaneState(db, first.taskId);
  if (reaped !== 1 || back.status !== 'pending') return fail(`reaper freed ${reaped}, row is ${back.status}`);
  const second = await claimed(db, L2);
  if (second.taskId !== first.taskId || second.epoch !== first.epoch + 1) return fail(`second claim is task ${second.taskId} epoch ${second.epoch}`);
  const late = await submit(blindFirst ? fenceBlindDb(db, first) : db, first, sub('stale-2', 'd'));
  if (late.ok) return fail('the FIRST worker\'s late submit was accepted after it lost its lease');
  const own = await submit(db, second, sub('stale-2', 'e'));
  if (!own.ok) return fail(`the current owner was refused: ${own.reason}`);
  const end = await readLaneState(db, first.taskId);
  return end.state.submission?.commit === sha('e')
    ? pass(`lease expired -> reaper -> ready -> ${L2} claimed epoch ${second.epoch}; late submit by epoch ${first.epoch} refused (${late.ok ? '' : late.reason}); owner's submit recorded`)
    : fail(`recorded commit is ${end.state.submission?.commit}`);
}

async function step3Duplicate(db: TxDb, pool: Pool, blindSecond: boolean): Promise<Line> {
  await truncate(pool);
  await replenish(db, [spec('dup-3')], 1);
  const old = await claimed(db, L1);
  await pool.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.taskId]);
  await pool.query('SELECT trinity_reap_expired_claims()');
  const owner = await claimed(db, L2);
  const a = await submit(db, owner, sub('dup-3', '1'));
  const b = await submit(blindSecond ? fenceBlindDb(db, owner) : db, owner, sub('dup-3', '2'));
  const c = await submit(db, old, sub('dup-3', '3'));
  const end = await readLaneState(db, owner.taskId);
  const submitted = end.state.receipts.filter((r) => r.event === 'submitted');
  const { rows } = await pool.query('SELECT artifact_url FROM trinity_tasks WHERE id = $1', [owner.taskId]);
  const results = `owner#1 ${a.ok ? 'ok' : 'refused'}, owner#2 ${b.ok ? 'ok' : 'refused'}, old attempt ${c.ok ? 'ok' : 'refused'}`;
  if (!a.ok || b.ok || c.ok) return fail(`${results}; ${submitted.length} submitted receipt(s)`);
  if (submitted.length !== 1 || end.state.submission?.commit !== sha('1') || !String(rows[0].artifact_url).endsWith(sha('1'))) {
    return fail(`${submitted.length} submitted receipts, recorded ${end.state.submission?.commit}`);
  }
  return pass(`${results}; exactly 1 submitted receipt, artifact_url and submission both commit ${sha('1').slice(0, 8)}`);
}

async function step4Outage(db: TxDb, pool: Pool): Promise<Line> {
  await truncate(pool);
  await replenish(db, [spec('primary-4', { priority: 90 }), spec('fallback-4', { priority: 10 })], 2);
  const h = await claimed(db, L1);
  if (h.spec.id !== 'primary-4') return fail(`expected primary-4 first, got ${h.spec.id}`);
  const until = await coolProvider(pool, 'groq', 600, 'drill: HTTP 429 from every key');
  const cooling = await coolingProviders(pool);
  if (!cooling.has('groq')) return fail('cooldown not visible to a reader');
  const ra = await recordRouteAttempt(db, h, { host: 'groq', model: 'drill', status: 429, reason: 'rate limited' }, until);
  const w = await waitForCapacity(db, h, until, 'every free route cooling');
  if (!ra.ok || !w.ok) return fail(`release refused: ${JSON.stringify({ ra, w })}`);
  const { rows } = await pool.query('SELECT status, claim_count, claimed_by FROM trinity_tasks WHERE id = $1', [h.taskId]);
  const st = (await readLaneState(db, h.taskId)).state;
  if (rows[0].status !== 'pending' || rows[0].claim_count !== 0 || st.attempts !== 0 || st.attempts !== h.attempts) {
    return fail(`not blameless: status ${rows[0].status}, claim_count ${rows[0].claim_count}, attempts ${st.attempts}`);
  }
  const next = await claimMake(db, L1);
  if (next.kind !== 'claimed' || next.handle.spec.id !== 'fallback-4') return fail(`fallback not claimed: ${next.kind === 'claimed' ? next.handle.spec.id : next.reason}`);
  const again = await claimMake(db, L2);
  return again.kind === 'none'
    ? pass(`groq cooled until ${until}; primary-4 released blameless (attempts 0, claim_count refunded to 0, notBefore set); fallback-4 claimed instead; primary-4 not re-offered while cooling`)
    : fail(`primary-4 re-offered during cooldown: ${again.kind}`);
}

async function step5Gate(db: TxDb, pool: Pool): Promise<{ line: Line; info: string }> {
  await truncate(pool);
  const action = 'operator: paste migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql into the Trinity prod Supabase SQL editor and report the result';
  const gated = spec('gated-5', { priority: 99 }, {
    ...basePacket(), task_id: 'gated-5',
    prerequisite_gates: [{ gate: 't12 lane worker role', owner: 'Sean', status: 'pending_operator', action }],
  });
  const fallback = spec('indep-5', { priority: 1 });
  const parts = partitionForEnqueue([gated, fallback], NOW());
  await replenish(db, parts.enqueue, parts.enqueue.length);
  const blocked = parts.operatorBlocked.map((b) => `${b.id}: ${b.check.operatorBlocked.map((g) => g.action).join('; ')}`);
  const got = await claimMake(db, L1);
  const after = await claimMake(db, L2);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM trinity_tasks WHERE metadata #>> '{t12,spec,id}' = 'gated-5'`);

  // INFO, not a step: does the STORE know about gates? Enqueue the gated spec directly and see.
  await truncate(pool);
  await replenish(db, [gated], 1);
  const direct = await claimMake(db, L1);
  const info = direct.kind === 'claimed'
    ? 'store-level gate: ABSENT. A gated spec put straight into the pool IS claimed; the gate holds only because partitionForEnqueue runs before replenish.'
    : `store-level gate: present (${direct.kind})`;

  const ok = got.kind === 'claimed' && got.handle.spec.id === 'indep-5' && after.kind === 'none' && rows[0].n === 0 && blocked.length === 1 && blocked[0]!.includes(action);
  return {
    line: ok
      ? pass(`gated-5 never enqueued, reported operator-blocked -> "${action}"; independent indep-5 claimed instead; next claim finds none`)
      : fail(`claimed ${got.kind === 'claimed' ? got.handle.spec.id : got.reason}; after ${after.kind}; gated rows ${rows[0].n}; blocked ${JSON.stringify(blocked)}`),
    info,
  };
}

async function main(): Promise<void> {
  assertThrowaway(URL_);
  if (process.argv.includes('--phase=claim')) return childClaim();

  const pool = new Pool({ connectionString: URL_, max: 8 });
  const db = poolDb(pool as never);
  const out: string[] = [];
  let failed = 0;
  const emit = (s: string) => { out.push(s); console.log(s); };
  const record = async (name: string, run: () => Promise<Line>) => {
    let line: Line;
    try { line = await run(); } catch (e) { line = fail(`threw: ${e instanceof Error ? e.message : String(e)}`); }
    const broken = await chainsOk(pool);
    if (line.ok && broken) line = fail(broken);
    const bad = (await pool.query('SELECT count(*)::int AS n FROM drill_status_seen WHERE status = ANY($1)', [FORBIDDEN])).rows[0].n;
    if (line.ok && bad > 0) line = fail(`${bad} write(s) into ${FORBIDDEN.join('/')}`);
    if (!line.ok) failed++;
    emit(`${line.ok ? 'PASS' : 'FAIL'} ${name}: ${line.detail}${line.ok ? ' [receipts verify]' : ''}`);
  };
  const control = async (name: string, run: () => Promise<Line>) => {
    let line: Line;
    try { line = await run(); } catch (e) { line = fail(`threw: ${e instanceof Error ? e.message : String(e)}`); }
    if (line.ok) failed++;
    emit(`${line.ok ? 'CONTROL BROKEN' : 'CONTROL OK'} ${name} with the fence blinded -> ${line.ok ? 'PASS (the drill cannot see a broken fence)' : 'FAIL as required'}: ${line.detail}`);
  };

  try {
    await resetSchema(pool);
    await record('1 RESTART', () => step1Restart(db, pool));
    await control('2 STALE LEASE', () => step2Stale(db, pool, true));
    await record('2 STALE LEASE', () => step2Stale(db, pool, false));
    await control('3 DUPLICATE COMPLETION', () => step3Duplicate(db, pool, true));
    await record('3 DUPLICATE COMPLETION', () => step3Duplicate(db, pool, false));
    await record('4 PROVIDER OUTAGE', () => step4Outage(db, pool));
    let info = '';
    await record('5 OPERATOR GATE', async () => { const r = await step5Gate(db, pool); info = r.info; return r.line; });
    emit(`INFO ${info}`);
    // Includes the control runs: a blinded submit still writes only pending_validation.
    const seen = (await pool.query('SELECT status, count(*)::int AS n FROM drill_status_seen GROUP BY status ORDER BY status')).rows;
    const bad = seen.filter((r: { status: string }) => FORBIDDEN.includes(r.status));
    emit(`${bad.length ? 'FAIL' : 'PASS'} NEVER-DONE: statuses ever written ${seen.map((r: { status: string; n: number }) => `${r.status}=${r.n}`).join(' ')}; forbidden ${FORBIDDEN.join('/')} = ${bad.length ? JSON.stringify(bad) : 0} (the audit table saw ${seen.length} distinct statuses, so it can see a presence)`);
    if (bad.length) failed++;
    // Can the audit see a forbidden status at all? Write one on a NON-lane row and look for it.
    await pool.query(`INSERT INTO trinity_tasks (description, status) VALUES ('drill audit probe, not a lane row', 'done')`);
    const probe = (await pool.query(`SELECT count(*)::int AS n FROM drill_status_seen WHERE status = 'done'`)).rows[0].n;
    if (probe !== 1) failed++;
    emit(`${probe === 1 ? 'CONTROL OK' : 'CONTROL BROKEN'} NEVER-DONE audit: a deliberate 'done' write on a non-lane row was ${probe === 1 ? 'seen' : 'NOT seen'} (written after the lane steps, so it does not count against them)`);
  } finally {
    await pool.end();
  }
  emit(failed ? `DRILL FAIL: ${failed} line(s)` : 'DRILL PASS');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`DRILL ERROR: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 2;
});
