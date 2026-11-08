/**
 * Fault injection for the T12 coding lanes.
 *
 * Three layers, so a skip is never mistaken for a pass:
 *  - pure rules and the real git adapters run everywhere;
 *  - the durable store needs a real Postgres, because locks, SKIP LOCKED, triggers and CHECKs are
 *    what is under test and a mock cannot return the other answer. Set T12_LANES_PG_URL to a
 *    THROWAWAY database (the suite drops and recreates its tables). Without it the block is
 *    reported as skipped, which means NOT_CHECKED.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  appendReceipt, claimMake, claimStage, heartbeat, LANE_POOL, MAX_ATTEMPTS, MAX_NOT_CHECKED, MAX_TASK_CLAIMS,
  pickClaimable, poolDb, readLaneState, recordIntegration, recordVerdict, recoverStages, releaseMake, replenish, submit,
  validateSpec, verifyReceipts, type DecisionReceipt, type Handle, type LaneSpec, type Submission, type TxDb, type Verdict,
} from '../src/orchestration/t12-lane-store';
import { runLanes, type LaneAdapters } from '../src/orchestration/t12-lane-runner';
import { buildMakePrompt, createGitAdapters, readMakerFiles, scrubbedEnv, verifyArgs, type PrClient } from '../src/orchestration/t12-lane-git';
import { canAssign } from '../src/orchestration/lane-registry';
import { __resetEmergencyHaltState } from '../src/services/emergency-halt';

const CONTROL = [{ file: 'src/thing.mjs', find: '42', replace: '41' }];
const spec = (id: string, over: Partial<LaneSpec> = {}): LaneSpec => ({
  id,
  repo: 'DealAppSeo/trustshell',
  title: `task ${id}`,
  prompt: 'Add a focused regression test for the behaviour described in this task.',
  paths: [`tests/${id}.test.mjs`],
  verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: CONTROL },
  risk: 'LOW',
  ...over,
});
const sub = (id: string): Submission => ({ branch: `t12/${id}`, commit: `c0mm1t-${id}`, base: 'b4se', files: [`tests/${id}.test.mjs`], host: 'groq' });
const TRANSCRIPT = 'node --test tests/x.test.mjs exited 0; without the deliverable it exited 1.';
const approve = (h: Handle): Verdict => ({ outcome: 'approved', commit: h.submission!.commit, transcript: TRANSCRIPT, evidence: { exit: 0 } });

describe('decision receipts', () => {
  const r: Omit<DecisionReceipt, 'seq' | 'prev' | 'hash'> = { at: 't', actor: 'a', origin: 'autonomous', event: 'e', from: 'x', to: 'y', epoch: 1, reason: 'r', evidence: { b: 1, a: 2 } };
  const chain = appendReceipt(appendReceipt([], r), { ...r, event: 'f' });

  it('verifies an intact chain', () => expect(verifyReceipts(chain)).toEqual({ ok: true }));
  it('verifies after keys are reordered, as a jsonb round trip does', () => {
    const reordered = chain.map((c) => ({ ...c, evidence: { a: 2, b: 1 } }));
    expect(verifyReceipts(reordered).ok).toBe(true);
  });
  it('catches an edited reason', () => {
    expect(verifyReceipts([{ ...chain[0]!, reason: 'changed' }, chain[1]!])).toEqual({ ok: false, brokenAt: 0 });
  });
  it('catches a removed receipt', () => expect(verifyReceipts([chain[1]!]).ok).toBe(false));
});

describe('spec vetting', () => {
  it('accepts a falsifiable spec', () => expect(validateSpec(spec('a'))).toEqual([]));
  it.each([
    ['another repo', { repo: 'DealAppSeo/repid-engine' }],
    ['a thin prompt', { prompt: 'fix it' }],
    ['no paths', { paths: [] }],
    ['a glob', { paths: ['tests/*.ts'] }],
    ['traversal', { paths: ['../secrets.txt'] }],
    ['an absolute path', { paths: ['/etc/passwd'] }],
    ['the workflow directory', { paths: ['.github/workflows/ci.yml'] }],
    ['package.json', { paths: ['package.json'] }],
    ['a verify target outside the paths', { verify: { runner: 'jest', target: 'other.test.ts', controls: CONTROL } }],
    ['context that escapes the checkout', { context: ['../../../.env.master'] }],
    ['an absolute context path', { context: ['C:/Users/someone/secret.txt'] }],
    ['context that is a secrets file', { context: ['.env'] }],
    ['a dependency it cannot be based on', { dependsOn: ['T12-001'] } as Partial<LaneSpec>],
    ['a test-only task with no control', { verify: { runner: 'node-test', target: 'tests/a.test.mjs' } }],
    ['a control on the deliverable itself', { verify: { runner: 'node-test', target: 'tests/a.test.mjs', controls: [{ file: 'tests/a.test.mjs', find: 'a', replace: 'b' }] } }],
    ['overwrites outside its paths', { overwrites: ['src/other.ts'] }],
    ['a control that changes nothing', { verify: { runner: 'node-test', target: 'tests/a.test.mjs', controls: [{ file: 'src/x.ts', find: 'a', replace: 'a' }] } }],
    ['too many controls', { verify: { runner: 'node-test', target: 'tests/a.test.mjs', controls: Array(6).fill(CONTROL[0]) } }],
    ['an unknown runner', { verify: { runner: 'bash', target: 'tests/a.test.mjs' } as never }],
  ])('refuses %s', (_n, over) => expect(validateSpec(spec('a', over as Partial<LaneSpec>)).length).toBeGreaterThan(0));
  it('refuses a prose-only task from the planning backlog', () => {
    expect(validateSpec({ id: 'T12-003', repo: 'DealAppSeo/trustshell', title: 't', prompt: 'x'.repeat(50), risk: 'LOW' })).toContain('names no paths');
  });
});

describe('path selection', () => {
  const c = (s: LaneSpec) => ({ spec: s });
  it('two new files in one directory do not conflict', () => {
    expect(pickClaimable([c(spec('b'))], [spec('a')])?.spec.id).toBe('b');
  });
  it('the same file conflicts, whatever its case', () => {
    expect(pickClaimable([c(spec('b', { paths: ['tests/A.test.mjs'], verify: { runner: 'jest', target: 'tests/A.test.mjs', controls: CONTROL } }))], [spec('A', { paths: ['tests/a.test.mjs'] })])).toBeUndefined();
  });
  it('the same path in another repo does not conflict at this layer', () => {
    const other = { ...spec('a'), repo: 'x/y' };
    expect(pickClaimable([c(spec('a'))], [other])?.spec.id).toBe('a');
  });
});

describe('maker output and environment', () => {
  it('reads a fenced answer', () => {
    expect(readMakerFiles('```json\n{"files":[{"path":"a.mjs","content":"x"}]}\n```', ['a.mjs'])).toEqual({ files: [{ path: 'a.mjs', content: 'x' }] });
  });
  it('refuses a file outside the lease and names it', () => {
    expect(readMakerFiles('{"files":[{"path":".github/workflows/x.yml","content":"x"}]}', ['a.mjs'])).toEqual({ reason: '.github/workflows/x.yml is outside the lease' });
  });
  it('refuses prose and says so', () => expect(readMakerFiles('I could not do this.', ['a.mjs'])).toEqual({ reason: 'no JSON object in the reply' }));
  it('accepts raw newlines and tabs inside strings, which free models emit', () => {
    expect(readMakerFiles('{"files":[{"path":"a.mjs","content":"a\n\tb \\"q\\"\r\nc"}]}', ['a.mjs'])).toEqual({ files: [{ path: 'a.mjs', content: 'a\n\tb "q"\r\nc' }] });
  });
  it('a raw newline does not get a path past the lease', () => {
    expect(readMakerFiles('{"files":[{"path":"a.mjs\n","content":"x"}]}', ['a.mjs'])).toEqual({ reason: 'a.mjs\n is outside the lease' });
  });
  it('names the JSON error when the reply is broken', () => {
    expect(readMakerFiles('{"files":[{"path":"a.mjs","content":"x"}]}}', ['a.mjs'])).toMatchObject({ reason: expect.stringContaining('invalid JSON') });
  });
  it('tells the maker why the last attempt failed', () => {
    expect(buildMakePrompt(spec('a'), {}, 'verify failed')).toContain('verify failed');
  });
  it('forces passWithNoTests off, because a repo config can turn it on', () => {
    expect(verifyArgs(spec('a', { verify: { runner: 'jest', target: 'tests/a.test.ts', controls: CONTROL }, paths: ['tests/a.test.ts'] }))).toContain('--passWithNoTests=false');
  });
  it('drops every credential from the child environment', () => {
    const env = scrubbedEnv('/h', { PATH: '/bin', GROQ_API_KEY: 'k', SUPABASE_SECRET_KEY: 's', GH_TOKEN: 't', DATABASE_URL: 'd' });
    expect(env.PATH).toBe('/bin');
    for (const k of ['GROQ_API_KEY', 'SUPABASE_SECRET_KEY', 'GH_TOKEN', 'DATABASE_URL']) expect(env[k]).toBeUndefined();
  });
});

describe('registry', () => {
  it('the harness is a verifying voice, never a lane that can be given work', () => {
    expect(canAssign('HARNESS', ['reasoning']).assignable).toBe(false);
  });
});

describe('the bridge cannot see a lane row', () => {
  it('no lane status is one the RepID bridge polls', () => {
    const bridge = readFileSync(join(__dirname, '../src/services/trinity-task-bridge.ts'), 'utf8');
    const m = /\.in\('status', \[([^\]]+)\]\)/.exec(bridge);
    expect(m).not.toBeNull();
    const polled = m![1]!.split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(polled).toContain('done');
    for (const s of ['pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked']) expect(polled).not.toContain(s);
  });
});

describe('real git adapters', () => {
  let root: string;
  let origin: string;
  let canon: string;
  let work: string;
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const PASS = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/thing.mjs';\ntest('answer', () => assert.equal(answer(), 42));\n";
  const NOOP = "import test from 'node:test';\ntest('ok', () => {});\n";
  const FAIL = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('no', () => assert.fail('nope'));\n";
  const handle = (s: LaneSpec, epoch: number, submission?: Submission): Handle => ({ taskId: 1, actor: 'trinity-lane-1', epoch, spec: s, attempts: 0, submission });
  const ask = (files: Array<{ path: string; content: string }>) => async () => ({ outcome: 'answered' as const, host: 'local', tried: ['local'], text: JSON.stringify({ files }) });
  const noPr: PrClient = { findByBranch: () => null, createDraft: () => 'https://example.test/pr/1' };
  const adapters = (over: Partial<Parameters<typeof createGitAdapters>[0]> = {}) =>
    createGitAdapters({ repoDirs: { 'DealAppSeo/trustshell': canon }, workRoot: work, ask: ask([]), allowExec: true, pr: noPr, timeoutMs: 60_000, ...over });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 't12-git-'));
    origin = join(root, 'origin.git');
    canon = join(root, 'canon');
    work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, canon], { stdio: 'ignore' });
    git(canon, 'config', 'user.email', 't@t');
    git(canon, 'config', 'user.name', 't');
    git(canon, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(canon, 'tests'));
    writeFileSync(join(canon, 'tests/existing.test.mjs'), NOOP);
    mkdirSync(join(canon, 'src'));
    writeFileSync(join(canon, 'src/thing.mjs'), 'export const answer = () => 42;\n');
    writeFileSync(join(canon, 'README.md'), 'x\n');
    git(canon, 'add', '.');
    git(canon, 'commit', '-q', '-m', 'seed');
    git(canon, 'push', '-q', 'origin', 'main');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function makeWith(s: LaneSpec, epoch: number, content: string): Promise<Submission> {
    const a = adapters({ ask: ask([{ path: s.paths[0]!, content }]) });
    const out = await a.make(handle(s, epoch), new AbortController().signal);
    if (!out.ok) throw new Error(out.reason);
    return out.submission;
  }

  it('approves real work: the test passes, and fails when the code under test is broken', async () => {
    const s = spec('good');
    const submission = await makeWith(s, 1, PASS);
    const v = await adapters().check(handle(s, 2, submission));
    expect(v.outcome).toBe('approved');
    if (v.outcome === 'approved') expect(v.evidence).toMatchObject({ commit: submission.commit, exit: 0, controls: [{ control: 'src/thing.mjs deliberately broken' }] });
  }, 60_000);

  it('rejects a failing test', async () => {
    const s = spec('bad');
    const v = await adapters().check(handle(s, 2, await makeWith(s, 1, FAIL)));
    expect(v).toMatchObject({ outcome: 'rejected' });
  }, 60_000);

  it('rejects a test that asserts nothing, even though deleting it would make the runner fail', async () => {
    const s = spec('hollow');
    const v = await adapters().check(handle(s, 2, await makeWith(s, 1, NOOP)));
    expect(v).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('vacuous') });
  }, 60_000);

  it('can approve a change to an existing test', async () => {
    const s = spec('existing', { overwrites: ['tests/existing.test.mjs'] });
    expect((await adapters().check(handle(s, 2, await makeWith(s, 1, PASS)))).outcome).toBe('approved');
  }, 60_000);

  it('rejects replacing an existing file the task did not name, even when the new test passes', async () => {
    const s = spec('existing');
    const v = await adapters().check(handle(s, 3, await makeWith(s, 2, PASS)));
    expect(v).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('tests/existing.test.mjs') });
  }, 60_000);

  it('a code change is controlled by reverting it', async () => {
    const s: LaneSpec = { ...spec('feat'), paths: ['src/feat.mjs', 'tests/feat.test.mjs'], verify: { runner: 'node-test', target: 'tests/feat.test.mjs' } };
    const test = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { f } from '../src/feat.mjs';\ntest('f', () => assert.equal(f(), 1));\n";
    const a = adapters({ ask: ask([{ path: 'src/feat.mjs', content: 'export const f = () => 1;\n' }, { path: 'tests/feat.test.mjs', content: test }]) });
    const out = await a.make(handle(s, 1), new AbortController().signal);
    if (!out.ok) throw new Error(out.reason);
    const v = await adapters().check(handle(s, 2, out.submission));
    expect(v.outcome).toBe('approved');
    if (v.outcome === 'approved') expect(v.evidence).toMatchObject({ controls: [{ control: 'the code change reverted' }] });
  }, 60_000);

  it('a row with no control at all can never be approved, even if it bypassed vetting', async () => {
    const s: LaneSpec = { ...spec('nocontrol'), verify: { runner: 'node-test', target: 'tests/nocontrol.test.mjs' } };
    const v = await adapters().check(handle(s, 2, await makeWith(s, 1, PASS)));
    expect(v).toMatchObject({ outcome: 'not_checked', reason: expect.stringContaining('no negative control') });
  }, 60_000);

  it('a control that no longer applies is NOT_CHECKED, not a pass', async () => {
    const s = spec('stale', { verify: { runner: 'node-test', target: 'tests/stale.test.mjs', controls: [{ file: 'src/thing.mjs', find: 'not in the file', replace: 'x' }] } });
    expect(await adapters().check(handle(s, 2, await makeWith(s, 1, PASS)))).toMatchObject({ outcome: 'not_checked' });
  }, 60_000);

  it('a model that changes nothing has failed, and it is not an infrastructure error', async () => {
    const s = spec('existing');
    const out = await adapters({ ask: ask([{ path: 'tests/existing.test.mjs', content: NOOP }]) }).make(handle(s, 9), new AbortController().signal);
    expect(out).toMatchObject({ ok: false, kind: 'maker_failed', reason: expect.stringContaining('no change') });
  }, 60_000);

  it('a running check does not stop other lanes from heartbeating', async () => {
    const s = spec('slow');
    const body = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/thing.mjs';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 1500)); assert.equal(answer(), 42); });\n";
    const submission = await makeWith(s, 1, body);
    let ticks = 0;
    const t = setInterval(() => ticks++, 100);
    await adapters().check(handle(s, 2, submission));
    clearInterval(t);
    expect(ticks).toBeGreaterThan(10);
  }, 60_000);

  it('rejects a commit that strays outside its lease', async () => {
    const s = spec('stray');
    const base = git(canon, 'rev-parse', 'origin/main');
    git(canon, 'checkout', '-q', '--detach', base);
    writeFileSync(join(canon, 'tests/stray.test.mjs'), PASS);
    writeFileSync(join(canon, 'extra.md'), 'a new file outside the lease\n');
    git(canon, 'add', '.');
    git(canon, 'commit', '-q', '-m', 'stray');
    const commit = git(canon, 'rev-parse', 'HEAD');
    git(canon, 'checkout', '-q', 'main');
    const v = await adapters().check(handle(s, 2, { branch: 'b', commit, base, files: ['tests/stray.test.mjs'], host: null }));
    expect(v).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('extra.md') });
  }, 60_000);

  it('a commit this host cannot see is NOT_CHECKED, never a failed check', async () => {
    const s = spec('ghost');
    const v = await adapters().check(handle(s, 2, { branch: 'b', commit: 'a'.repeat(40), base: 'b'.repeat(40), files: [], host: null }));
    expect(v).toMatchObject({ outcome: 'not_checked', reason: expect.stringContaining('not available') });
  });

  it('will not execute model-written code unless the host allows it', async () => {
    const s = spec('noexec');
    const v = await adapters({ allowExec: false }).check(handle(s, 2, await makeWith(s, 1, PASS)));
    expect(v).toMatchObject({ outcome: 'not_checked' });
  }, 60_000);

  it('a parent secret is not visible to the code under test', async () => {
    process.env.T12_TEST_FAKE_SECRET = 'leak';
    try {
      const s = spec('env');
      const body = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/thing.mjs';\ntest('clean', () => { assert.equal(process.env.T12_TEST_FAKE_SECRET, undefined); assert.equal(answer(), 42); });\n";
      expect((await adapters().check(handle(s, 2, await makeWith(s, 1, body)))).outcome).toBe('approved');
    } finally {
      delete process.env.T12_TEST_FAKE_SECRET;
    }
  }, 60_000);

  it('maker reports a rate limit and a dead wave distinctly, and touches nothing', async () => {
    const s = spec('quiet');
    const limited = await adapters({ ask: async () => ({ outcome: 'rate_limited', host: 'groq', tried: ['groq'], text: null }) }).make(handle(s, 1), new AbortController().signal);
    expect(limited).toMatchObject({ ok: false, kind: 'rate_limited' });
    const dead = await adapters({ ask: async () => ({ outcome: 'NOT_CHECKED', host: null, tried: [], text: null }) }).make(handle(s, 2), new AbortController().signal);
    expect(dead).toMatchObject({ ok: false, kind: 'infra' });
    expect(git(canon, 'branch', '--list', 't12/quiet-*')).toBe('');
  }, 60_000);

  it('publish is idempotent: a re-run after a crash opens no second PR', async () => {
    const s = spec('pub');
    const submission = await makeWith(s, 1, PASS);
    let created = 0;
    let known: string | null = null;
    const pr: PrClient = { findByBranch: () => known, createDraft: () => { created++; known = 'https://example.test/pr/9'; return known; } };
    const a = adapters({ pr });
    const first = await a.publish(handle(s, 3, submission));
    const second = await a.publish(handle(s, 4, submission));
    expect(second.url).toBe(first.url);
    expect(created).toBe(1);
    expect(git(canon, 'ls-remote', 'origin', submission.branch)).toContain(submission.commit);
  }, 60_000);
});

const notHalted = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { emergency_halt: false }, error: null }) }) }) }) } as never;
const PG = process.env.T12_LANES_PG_URL;
const describePg = PG ? describe : describe.skip;
if (!PG) {
  // eslint-disable-next-line no-console
  console.warn('[t12-lanes] NOT_CHECKED: the durable store block needs T12_LANES_PG_URL (a throwaway Postgres).');
}

describePg('durable lanes on real Postgres', () => {
  const FLEET_CLAIM_SQL = `UPDATE trinity_tasks
        SET status = 'doing', claimed_by = $1, claimed_at = $2, started_at = $2,
            claim_count = COALESCE(claim_count, 0) + 1
      WHERE id = (
        SELECT id FROM trinity_tasks
         WHERE (assigned_to = $1 OR (assigned_to IS NULL AND (agent_assigned = $1 OR agent_assigned IS NULL)))
           AND status = ANY($3)
           AND claimed_by IS NULL
           AND COALESCE(claim_count, 0) < $4
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
  const CLAIMABLE = ['pending', 'todo', 'assigned', 'pending_clarification'];

  let pool: Pool;
  let db: TxDb;
  const L1 = 'trinity-lane-1';
  const L2 = 'trinity-lane-2';
  const L3 = 'trinity-lane-3';

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 16 });
    db = poolDb(pool as never);
    await pool.query(readFileSync(join(__dirname, 'fixtures/t12-lanes-schema.sql'), 'utf8'));
    await pool.query(readFileSync(join(__dirname, '../migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8'));
  });
  afterAll(async () => pool.end());
  beforeEach(async () => pool.query('TRUNCATE trinity_tasks RESTART IDENTITY; TRUNCATE agent_resource_claims RESTART IDENTITY'));

  const seed = (...specs: LaneSpec[]) => replenish(db, specs, specs.length);
  const row = async (id: number) => (await pool.query('SELECT * FROM trinity_tasks WHERE id = $1', [id])).rows[0];
  const claimOne = async (lane: string): Promise<Handle> => {
    const c = await claimMake(db, lane);
    if (c.kind !== 'claimed') throw new Error(`expected a claim, got ${c.kind}: ${c.reason}`);
    return c.handle;
  };
  const expireLease = (id: number) => pool.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
  const ageStage = (id: number) => pool.query(`UPDATE trinity_tasks SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [id]);
  /** Maker done, ready for a checker. */
  const toCheck = async (id: string) => {
    await seed(spec(id));
    const h = await claimOne(L1);
    expect(await submit(db, h, sub(id))).toEqual({ ok: true });
    return h;
  };

  it('three lanes racing over 30 tasks never double-claim', async () => {
    const specs = Array.from({ length: 30 }, (_, i) => spec(`race-${i}`));
    await seed(...specs);
    const got: Array<{ lane: string; id: number }> = [];
    await Promise.all([L1, L2, L3].map(async (lane) => {
      for (;;) {
        const c = await claimMake(db, lane);
        if (c.kind !== 'claimed') return;
        got.push({ lane, id: c.handle.taskId });
      }
    }));
    expect(got).toHaveLength(30);
    expect(new Set(got.map((g) => g.id)).size).toBe(30);
    const { rows } = await pool.query(`SELECT claim_count, status, expires_at > now() AS live FROM trinity_tasks`);
    for (const r of rows) expect(r).toEqual({ claim_count: 1, status: 'claimed', live: true });
    expect(new Set(got.map((g) => g.lane)).size).toBe(3);
  }, 60_000);

  it('three lanes cannot hold the same file, and the lock lasts until the check passes', async () => {
    const shared = { paths: ['tests/shared.test.mjs'], verify: { runner: 'node-test' as const, target: 'tests/shared.test.mjs', controls: CONTROL } };
    await seed(spec('s1', shared), spec('s2', shared), spec('s3', shared), spec('free'));
    const results = await Promise.all([L1, L2, L3].map((l) => claimMake(db, l)));
    const claimed = results.flatMap((r) => (r.kind === 'claimed' ? [r.handle] : []));
    expect(claimed.map((h) => h.spec.id).sort()).toEqual(['free', 's1']);
    expect(results.filter((r) => r.kind === 'none')).toHaveLength(1);

    const s1 = claimed.find((h) => h.spec.id === 's1')!;
    await submit(db, s1, sub('s1'));
    expect((await claimMake(db, L3)).kind).toBe('none');

    const check = await claimStage(db, 'awaiting_check', L2);
    expect(check?.spec.id).toBe('s1');
    await recordVerdict(db, check!, approve(check!));
    const next = await claimOne(L3);
    expect(next.spec.id).toBe('s2');
  }, 30_000);

  it('a crashed maker: the real cron frees it, another lane takes over, the zombie is refused', async () => {
    await seed(spec('crash'));
    const zombie = await claimOne(L1);
    await expireLease(zombie.taskId);

    expect(await heartbeat(db, zombie)).toMatchObject({ ok: false, reason: 'lease expired' });
    expect(await submit(db, zombie, sub('crash'))).toMatchObject({ ok: false, reason: 'lease expired' });

    expect((await pool.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n).toBe(1);
    const reaped = await row(zombie.taskId);
    expect(reaped).toMatchObject({ status: 'pending', claimed_by: null, expires_at: null });

    const next = await claimOne(L2);
    expect(next.taskId).toBe(zombie.taskId);
    expect(next.epoch).toBe(zombie.epoch + 1);

    expect(await submit(db, zombie, sub('crash'))).toMatchObject({ ok: false, fenced: true });
    expect((await row(zombie.taskId)).claimed_by).toBe(L2);

    const { state } = await readLaneState(pool, zombie.taskId);
    expect(state.receipts.map((r) => r.event)).toEqual(['enqueued', 'claimed', 'lease_reaped', 'claimed']);
    expect(verifyReceipts(state.receipts).ok).toBe(true);
  });

  it('the fence is the epoch, not the name: a lane that restarts cannot resume its old claim', async () => {
    await seed(spec('restart'));
    const old = await claimOne(L1);
    await expireLease(old.taskId);
    await pool.query('SELECT trinity_reap_expired_claims()');
    const fresh = await claimOne(L1);
    expect(await submit(db, old, sub('restart'))).toMatchObject({ ok: false, reason: expect.stringContaining('epoch') });
    expect(await submit(db, fresh, sub('restart'))).toEqual({ ok: true });
  });

  it('a right epoch under the wrong name is refused', async () => {
    await seed(spec('forged'));
    const h = await claimOne(L1);
    expect(await submit(db, { ...h, actor: L2 }, sub('forged'))).toMatchObject({ ok: false, reason: expect.stringContaining('held by') });
  });

  it('a live heartbeat holds the lease past the old expiry', async () => {
    await seed(spec('alive'));
    const h = await claimOne(L1);
    await pool.query(`UPDATE trinity_tasks SET expires_at = now() + interval '2 seconds' WHERE id = $1`, [h.taskId]);
    expect(await heartbeat(db, h)).toEqual({ ok: true });
    expect((await pool.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n).toBe(0);
    const { rows } = await pool.query(`SELECT expires_at > now() + interval '10 minutes' AS long FROM trinity_tasks WHERE id = $1`, [h.taskId]);
    expect(rows[0].long).toBe(true);
  });

  it('a heartbeat cannot run past the 12 hour ceiling', async () => {
    await seed(spec('forever'));
    const h = await claimOne(L1);
    await pool.query(`UPDATE trinity_tasks SET claimed_at = now() - interval '13 hours' WHERE id = $1`, [h.taskId]);
    expect(await heartbeat(db, h)).toMatchObject({ ok: false, reason: expect.stringContaining('ceiling') });
  });

  it('the fleet cannot claim a lane task, and the same statement does claim an open one', async () => {
    await seed(spec('mine'));
    const fleet = () => pool.query(FLEET_CLAIM_SQL, ['trinity-orch', new Date().toISOString(), CLAIMABLE, 12]);
    expect((await fleet()).rows).toHaveLength(0);
    await pool.query(`INSERT INTO trinity_tasks (description, status) VALUES ('open', 'pending')`);
    expect((await fleet()).rows).toHaveLength(1);
  });

  it('the fleet reaper does not see a live lane row, and does see a stale doing row', async () => {
    await seed(spec('held'));
    const h = await claimOne(L1);
    await pool.query(`UPDATE trinity_tasks SET claimed_at = now() - interval '3 hours' WHERE id = $1`, [h.taskId]);
    await pool.query(`INSERT INTO trinity_tasks (description, status, claimed_by, claimed_at) VALUES ('old', 'doing', 'trinity-orch', now() - interval '3 hours')`);
    const { rows } = await pool.query(`SELECT description FROM trinity_tasks WHERE status = ANY($1) AND claimed_at < now() - interval '1 hour'`, [['doing', 'in_progress']]);
    expect(rows).toEqual([{ description: 'old' }]);
  });

  it('after submit the cron reaper has nothing to resurrect', async () => {
    const h = await toCheck('safe');
    expect((await row(h.taskId)).expires_at).toBeNull();
    expect((await pool.query('SELECT trinity_reap_expired_claims() AS n')).rows[0].n).toBe(0);
    expect((await row(h.taskId)).status).toBe('pending_validation');
  });

  it('a producer cannot check its own work', async () => {
    await toCheck('own');
    expect(await claimStage(db, 'awaiting_check', L1)).toBeNull();
    expect((await claimStage(db, 'awaiting_check', L2))?.spec.id).toBe('own');
  });

  it('a crashed checker returns the task to checking, not to the maker, and its verdict is refused', async () => {
    const m = await toCheck('checkcrash');
    const zombie = (await claimStage(db, 'awaiting_check', L2))!;
    await ageStage(m.taskId);
    expect(await recoverStages(db)).toBe(1);
    expect(await row(m.taskId)).toMatchObject({ status: 'pending_validation', claimed_by: null });
    expect(await recordVerdict(db, zombie, approve(zombie))).toMatchObject({ ok: false, fenced: true });
    const next = (await claimStage(db, 'awaiting_check', L3))!;
    expect(next.epoch).toBeGreaterThan(zombie.epoch);
    expect(await recordVerdict(db, next, approve(next))).toEqual({ ok: true });
  });

  it('a live check is not recovered', async () => {
    await toCheck('livecheck');
    await claimStage(db, 'awaiting_check', L2);
    expect(await recoverStages(db)).toBe(0);
  });

  it('approval records the verifier and stays out of every status the bridge polls', async () => {
    const m = await toCheck('ok');
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    expect(await recordVerdict(db, c, approve(c))).toEqual({ ok: true });
    const r = await row(m.taskId);
    expect(r).toMatchObject({ status: 'pending_validation', verifier_verdict: 'approved', final_verdict: 'verified_done', verification_method: 'fresh_checkout_rerun', claimed_by: null, verify_count: 1 });
    expect(r.verified_at).not.toBeNull();
    expect(r.artifact_url).toBe('git://DealAppSeo/trustshell@c0mm1t-ok');
    const { state } = await readLaneState(pool, m.taskId);
    expect(state.receipts.at(-1)!.evidence).toMatchObject({ independence: 'same_controller_rerun' });
  });

  it('approval of the wrong commit is downgraded, never written', async () => {
    const m = await toCheck('wrongcommit');
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    await recordVerdict(db, c, { outcome: 'approved', commit: 'someothercommit', transcript: TRANSCRIPT, evidence: {} });
    const r = await row(m.taskId);
    expect(r.final_verdict).toBeNull();
    expect(r.verifier_verdict).toBe('unclear');
    expect((await readLaneState(pool, m.taskId)).state.stage).toBe('awaiting_check');
  });

  it('an approval with an empty transcript is held by the handoff gate', async () => {
    const m = await toCheck('thin');
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    await recordVerdict(db, c, { outcome: 'approved', commit: c.submission!.commit, transcript: 'ok', evidence: {} });
    expect((await row(m.taskId)).final_verdict).toBeNull();
  });

  it('a rejection goes back with its reason, and ends in cancelled after the attempt limit', async () => {
    await seed(spec('rej'));
    let id = 0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const h = await claimOne(L1);
      id = h.taskId;
      if (i > 1) expect(h.lastRejection).toBe('verify failed');
      await submit(db, h, sub('rej'));
      const c = (await claimStage(db, 'awaiting_check', L2))!;
      await recordVerdict(db, c, { outcome: 'rejected', reason: 'verify failed' });
    }
    expect(await row(id)).toMatchObject({ status: 'cancelled', final_verdict: 'rejected', verifier_verdict: 'rejected', claimed_by: null, claimed_at: null });
    expect((await claimMake(db, L1)).kind).toBe('none');
  });

  it('not_checked is never approved and parks after the limit', async () => {
    const m = await toCheck('nc');
    for (let i = 0; i < MAX_NOT_CHECKED; i++) {
      const c = (await claimStage(db, 'awaiting_check', L2))!;
      await recordVerdict(db, c, { outcome: 'not_checked', reason: 'runner down' });
    }
    expect(await row(m.taskId)).toMatchObject({ status: 'not_checked', verifier_verdict: 'unclear', final_verdict: null });
    expect(await claimStage(db, 'awaiting_check', L2)).toBeNull();
  });

  it('a blameless release costs no attempt; a bad output does', async () => {
    await seed(spec('rel'));
    const a = await claimOne(L1);
    await releaseMake(db, a, 'rate limited', true);
    expect((await readLaneState(pool, a.taskId)).state.attempts).toBe(0);
    const b = await claimOne(L1);
    await releaseMake(db, b, 'unparseable', false);
    expect((await readLaneState(pool, b.taskId)).state).toMatchObject({ attempts: 1, lastRejection: 'unparseable', stage: 'ready' });
  });

  it('host outages never exhaust a task', async () => {
    await seed(spec('outage'));
    let id = 0;
    for (let i = 0; i < MAX_TASK_CLAIMS * 2; i++) {
      const h = await claimOne(L1);
      id = h.taskId;
      await releaseMake(db, h, 'host down', true);
    }
    expect((await row(id)).claim_count).toBe(0);
  });

  it('a task that keeps crashing stops at the claim cap', async () => {
    await seed(spec('poison'));
    for (let i = 0; i < MAX_TASK_CLAIMS; i++) {
      const h = await claimOne(L1);
      await expireLease(h.taskId);
      await pool.query('SELECT trinity_reap_expired_claims()');
    }
    expect((await claimMake(db, L1)).kind).toBe('none');
    const r = await row(1);
    expect(r.status).toBe('not_checked');
    expect(r.stuck_reason).toContain('claim limit');
    expect(r.final_verdict).toBeNull();
    const { state } = await readLaneState(pool, 1);
    expect(state.receipts.slice(-2).map((x) => x.event)).toEqual(['lease_reaped', 'claim_limit']);
    expect(verifyReceipts(state.receipts).ok).toBe(true);
  });

  it('a malformed row in the pool cannot take the lanes down', async () => {
    await pool.query(`INSERT INTO trinity_tasks (description, status, assigned_to) VALUES ('no lane state', 'pending', $1)`, [LANE_POOL]);
    await pool.query(`INSERT INTO trinity_tasks (description, status, assigned_to, claimed_by, claimed_at) VALUES ('no lane state', 'pending_validation', $1, 'trinity-x', now() - interval '2 hours')`, [LANE_POOL]);
    await seed(spec('fine'));
    expect(await recoverStages(db)).toBe(0);
    expect((await claimOne(L1)).spec.id).toBe('fine');
  });

  it('a failure inside a transition leaves neither the state change nor a receipt', async () => {
    await seed(spec('atomic'));
    const h = await claimOne(L1);
    const failing: TxDb = {
      query: db.query,
      tx: (fn) => db.tx((c) => fn({
        query: (sql, params) => (/^UPDATE trinity_tasks SET\s+status/.test(sql.trim()) ? Promise.reject(new Error('injected')) : c.query(sql, params)),
      })),
    };
    await expect(submit(failing, h, sub('atomic'))).rejects.toThrow('injected');
    const { status, state } = await readLaneState(pool, h.taskId);
    expect(status).toBe('claimed');
    expect(state.stage).toBe('making');
    expect(state.receipts.map((r) => r.event)).toEqual(['enqueued', 'claimed']);
    expect(await submit(db, h, sub('atomic'))).toEqual({ ok: true });
  });

  it('every decision is receipted, and an edit to a stored receipt is caught', async () => {
    const m = await toCheck('audit');
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    await recordVerdict(db, c, approve(c));
    const i = (await claimStage(db, 'approved', L3))!;
    await recordIntegration(db, i, 'https://example.test/pr/1');

    const { state } = await readLaneState(pool, m.taskId);
    expect(state.receipts.map((r) => r.event)).toEqual(['enqueued', 'claimed', 'submitted', 'stage_claimed', 'check_approved', 'stage_claimed', 'integrated']);
    expect(state.receipts.map((r) => r.actor)).toEqual(['replenish', L1, L1, L2, L2, L3, L3]);
    expect(verifyReceipts(state.receipts).ok).toBe(true);

    await pool.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,receipts,4,reason}', '"edited"') WHERE id = $1`, [m.taskId]);
    expect(verifyReceipts((await readLaneState(pool, m.taskId)).state.receipts)).toEqual({ ok: false, brokenAt: 4 });
  });

  it('integration crash after publishing: recovery re-publishes without a second PR', async () => {
    const m = await toCheck('pubcrash');
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    await recordVerdict(db, c, approve(c));
    const zombie = (await claimStage(db, 'approved', L3))!;
    await ageStage(m.taskId);
    expect(await recoverStages(db)).toBe(1);
    expect((await readLaneState(pool, m.taskId)).state.stage).toBe('approved');
    expect(await recordIntegration(db, zombie, 'https://example.test/pr/1')).toMatchObject({ ok: false, fenced: true });
    const retry = (await claimStage(db, 'approved', L1))!;
    expect(await recordIntegration(db, retry, 'https://example.test/pr/1')).toEqual({ ok: true });
    expect(await row(m.taskId)).toMatchObject({ external_artifact_url: 'https://example.test/pr/1', status: 'pending_validation' });
  });

  it('a HIGH risk task is verified but never auto-published', async () => {
    await seed(spec('high', { risk: 'HIGH' }));
    const h = await claimOne(L1);
    await submit(db, h, sub('high'));
    const c = (await claimStage(db, 'awaiting_check', L2))!;
    await recordVerdict(db, c, approve(c));
    expect(await claimStage(db, 'approved', L3)).toBeNull();
  });

  it('replenish dedupes, refuses prose, and reports underflow instead of inventing work', async () => {
    const prose = { id: 'T12-prose', repo: 'DealAppSeo/trustshell', title: 't', prompt: 'x'.repeat(60), risk: 'LOW' } as unknown as LaneSpec;
    const first = await replenish(db, [spec('r1'), spec('r2'), prose], 5);
    expect(first.inserted).toEqual(['r1', 'r2']);
    expect(first.invalid.map((i) => i.id)).toEqual(['T12-prose']);
    expect(first.underflow).toContain('READY_UNDERFLOW');
    const again = await replenish(db, [spec('r1'), spec('r2')], 5);
    expect(again.inserted).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM trinity_tasks')).rows[0].n).toBe(2);
  });

  it('replenish stops at the target', async () => {
    const r = await replenish(db, [spec('a1'), spec('a2'), spec('a3')], 2);
    expect(r.inserted).toEqual(['a1', 'a2']);
    expect(r.underflow).toBeNull();
  });

  it('three lanes replenishing at once insert each task once', async () => {
    const specs = Array.from({ length: 12 }, (_, i) => spec(`dup-${i}`));
    await Promise.all([1, 2, 3].map(() => replenish(db, specs, 12)));
    expect((await pool.query('SELECT count(*)::int AS n FROM trinity_tasks')).rows[0].n).toBe(12);
  }, 30_000);

  it('the daily cap pauses claiming and says so', async () => {
    await seed(spec('q1'), spec('q2'));
    expect((await claimMake(db, L1, { dailyCap: 1 })).kind).toBe('claimed');
    const r = await claimMake(db, L2, { dailyCap: 1 });
    expect(r).toMatchObject({ kind: 'paused', reason: expect.stringContaining('QUOTA_PAUSED') });
  });

  it('a task row naming another repo is refused at claim, even if written straight to the table', async () => {
    await seed(spec('legit'));
    await pool.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,spec,repo}', '"evil/repo"')`);
    expect((await claimMake(db, L1)).kind).toBe('none');
  });

  describe('runner', () => {
    function fakeAdapters(over: Partial<LaneAdapters> = {}): LaneAdapters & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        make: async (h) => { calls.push(`make:${h.actor}:${h.spec.id}`); return { ok: true, submission: sub(h.spec.id) }; },
        check: async (h) => { calls.push(`check:${h.actor}:${h.spec.id}`); return approve(h); },
        publish: async (h) => { calls.push(`publish:${h.actor}:${h.spec.id}`); return { url: `https://example.test/pr/${h.spec.id}` }; },
        ...over,
      };
    }
    const base = (adapters: LaneAdapters, specs: LaneSpec[], over = {}) => ({
      db, haltClient: notHalted, lanes: [L1, L2, L3], adapters, publishEnabled: true, specs: () => specs, readyTarget: specs.length, heartbeatMs: 50, idleMs: 20, ...over,
    });

    it('three lanes take nine tasks all the way through, refilling on their own', async () => {
      const specs = Array.from({ length: 9 }, (_, i) => spec(`e2e-${i}`));
      const a = fakeAdapters();
      const report = await runLanes(base(a, specs, { readyTarget: 3 }));
      expect(report).toMatchObject({ made: 9, approved: 9, integrated: 9, rejected: 0, fenceRefused: [], paused: null, stoppedBy: 'idle' });
      const { rows } = await pool.query(`SELECT metadata #> '{t12}' AS s FROM trinity_tasks`);
      expect(rows).toHaveLength(9);
      for (const { s } of rows) {
        expect(s.stage).toBe('integrated');
        const maker = s.receipts.find((r: DecisionReceipt) => r.event === 'submitted').actor;
        const checker = s.receipts.find((r: DecisionReceipt) => r.event === 'check_approved').actor;
        expect(checker).not.toBe(maker);
        expect(verifyReceipts(s.receipts).ok).toBe(true);
      }
      expect(new Set(a.calls.filter((c) => c.startsWith('make')).map((c) => c.split(':')[1])).size).toBeGreaterThan(1);
    }, 60_000);

    it('a maker that hangs past its lease loses it and its output is discarded', async () => {
      const a = fakeAdapters({
        make: (h, signal) => new Promise((resolve) => {
          void expireLease(h.taskId);
          signal.addEventListener('abort', () => resolve({ ok: true, submission: sub(h.spec.id) }), { once: true });
        }),
      });
      const report = await runLanes(base(a, [spec('hung')], { lanes: [L1], publishEnabled: false, maxSteps: 1 }));
      expect(report.made).toBe(0);
      expect(report.fenceRefused.join()).toContain('lease lost');
    }, 30_000);

    it('one lane alone cannot approve its own work: it waits for another', async () => {
      const a = fakeAdapters();
      const report = await runLanes(base(a, [spec('solo')], { lanes: [L1] }));
      expect(report).toMatchObject({ made: 1, approved: 0 });
      expect((await pool.query(`SELECT metadata #>> '{t12,stage}' AS s FROM trinity_tasks`)).rows[0].s).toBe('awaiting_check');
    }, 30_000);

    it('a dead run leaves state that a fresh process finishes, with nothing in memory', async () => {
      const specs = [spec('resume')];
      await runLanes(base(fakeAdapters(), specs, { lanes: [L1], publishEnabled: false }));
      const secondPool = new Pool({ connectionString: PG, max: 8 });
      try {
        const report = await runLanes({ ...base(fakeAdapters(), specs), db: poolDb(secondPool as never), lanes: [L2, L3] });
        expect(report).toMatchObject({ made: 0, approved: 1, integrated: 1 });
      } finally {
        await secondPool.end();
      }
    }, 30_000);

    it('a route that never cools is bounded, and costs no attempt', async () => {
      const a = fakeAdapters({ make: async () => ({ ok: false, kind: 'rate_limited', reason: 'groq 429' }) });
      const report = await runLanes(base(a, [spec('rl')], { lanes: [L1, L2] }));
      expect(report.paused).toContain('route retries exhausted');
      expect(a.calls.filter((c) => c.startsWith('make'))).toHaveLength(0);
      expect((await pool.query(`SELECT metadata #>> '{t12,attempts}' AS a, status FROM trinity_tasks`)).rows[0]).toEqual({ a: '0', status: 'pending' });
    }, 30_000);

    it('a dead host stops the run after one call instead of looping on the same row', async () => {
      let calls = 0;
      const a = fakeAdapters({ make: async () => { calls++; return { ok: false, kind: 'infra', reason: 'no free host answered' }; } });
      const report = await runLanes(base(a, [spec('dead')], { lanes: [L1] }));
      expect(calls).toBe(1);
      expect(report.paused).toContain('infra');
      expect((await pool.query('SELECT claim_count, status FROM trinity_tasks')).rows[0]).toEqual({ claim_count: 0, status: 'pending' });
    }, 30_000);

    it('one dropped connection does not take the other lanes down', async () => {
      let tripped = false;
      const flaky: TxDb = { query: db.query, tx: (fn) => { if (!tripped) { tripped = true; return Promise.reject(new Error('connection dropped')); } return db.tx(fn); } };
      const report = await runLanes({ ...base(fakeAdapters(), [spec('f1'), spec('f2'), spec('f3')]), db: flaky });
      expect(report.errors).toEqual(['connection dropped']);
      expect(report).toMatchObject({ made: 3, approved: 3, integrated: 3 });
    }, 60_000);

    it('a checker that throws is NOT_CHECKED, never approved', async () => {
      const a = fakeAdapters({ check: async () => { throw new Error('runner died'); } });
      const report = await runLanes(base(a, [spec('thrown')], { lanes: [L1, L2], publishEnabled: false }));
      expect(report.approved).toBe(0);
      expect(report.notChecked).toBe(1);
      for (let i = 1; i < MAX_NOT_CHECKED; i++) await runLanes(base(a, [spec('thrown')], { lanes: [L1, L2], publishEnabled: false }));
      expect((await pool.query(`SELECT final_verdict, status FROM trinity_tasks`)).rows[0]).toEqual({ final_verdict: null, status: 'not_checked' });
    }, 60_000);

    it('publishing off: verified work waits and nothing is published', async () => {
      const a = fakeAdapters();
      const report = await runLanes(base(a, [spec('nopub')], { publishEnabled: false }));
      expect(report).toMatchObject({ approved: 1, integrated: 0 });
      expect(a.calls.filter((c) => c.startsWith('publish'))).toEqual([]);
    }, 30_000);

    it('checks disabled on this host: work waits, unburned, for a host that may run it', async () => {
      const a = fakeAdapters();
      const report = await runLanes(base(a, [spec('nocheck')], { publishEnabled: false, checkEnabled: false }));
      expect(report).toMatchObject({ made: 1, approved: 0, notChecked: 0 });
      expect(a.calls.filter((c) => c.startsWith('check'))).toEqual([]);
    }, 30_000);

    it('the emergency halt stops every lane before any work', async () => {
      __resetEmergencyHaltState();
      const a = fakeAdapters();
      const halted = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { emergency_halt: true }, error: null }) }) }) }) } as never;
      const report = await runLanes({ ...base(a, [spec('halted')]), haltClient: halted });
      __resetEmergencyHaltState();
      expect(report.stoppedBy).toBe('emergency_halt');
      expect(a.calls).toEqual([]);
      expect((await pool.query('SELECT count(*)::int AS n FROM trinity_tasks')).rows[0].n).toBe(0);
    }, 30_000);

    it('the stop switch halts before any work', async () => {
      const a = fakeAdapters();
      const report = await runLanes(base(a, [spec('stop')], { stop: () => true }));
      expect(report.stoppedBy).toBe('stop_switch');
      expect(a.calls).toEqual([]);
    });

    it('a publish failure strands nothing: the claim recovers and retries', async () => {
      let tries = 0;
      const a = fakeAdapters({ publish: async () => { if (++tries === 1) throw new Error('github 502'); return { url: 'https://example.test/pr/r' }; } });
      await runLanes(base(a, [spec('retry')], { maxSteps: 12 }));
      const { rows } = await pool.query(`SELECT id FROM trinity_tasks`);
      await ageStage(rows[0].id);
      const report = await runLanes(base(a, [spec('retry')]));
      expect(report.integrated).toBe(1);
      expect(tries).toBe(2);
    }, 60_000);
  });

  it('a lane pool name survives the production name normalizer', async () => {
    await seed(spec('name'));
    expect((await pool.query('SELECT assigned_to FROM trinity_tasks')).rows[0].assigned_to).toBe(LANE_POOL);
    await expect(claimMake(db, 'Lane_1')).rejects.toThrow('invalid lane actor');
  });
});
