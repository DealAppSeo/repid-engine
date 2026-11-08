/**
 * Per-provider cooldowns and bounded routing for the T12 coding lanes. Durable behaviour needs a
 * real Postgres, so that block follows the same rule as t12-lanes.test.ts: without its throwaway
 * database it reports as skipped, which means NOT_CHECKED.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { T12_ROUTES, t12Target } from '../src/orchestration/t12-attempt';
import { askFailure } from '../src/orchestration/t12-lane-git';
import { COOLDOWN_SECONDS, MAX_HOSTS_PER_ASK, T12_LANE_ROUTE_ORDER, cooldownFor, createRoutedAsk } from '../src/orchestration/t12-lane-route';
import { runLanes, type LaneAdapters } from '../src/orchestration/t12-lane-runner';
import {
  LANE_POOL, claimMake, claimStage, coolProvider, coolingProviders, poolDb, readLaneState, recordVerdict, replenish, submit, verifyReceipts,
  type DecisionReceipt, type Handle, type LaneSpec, type TxDb, type Verdict,
} from '../src/orchestration/t12-lane-store';

const CONTROL = [{ file: 'src/thing.mjs', find: '42', replace: '41' }];
const spec = (id: string): LaneSpec => ({
  id, repo: 'DealAppSeo/trustshell', title: `task ${id}`,
  prompt: 'Add a focused regression test for the behaviour described in this task.',
  paths: [`tests/${id}.test.mjs`], verify: { runner: 'node-test', target: `tests/${id}.test.mjs`, controls: CONTROL }, risk: 'LOW',
});
const ALL_KEYS = { T12_FREE_WAVE: 'true', NVIDIA_NIM_API_KEY: 'nim-k', OPENROUTER_API_KEY: 'or-k', CEREBRAS_API_KEY: 'cb-k', GROQ_API_KEY: 'gq-k' };
const hostOf = (url: string) => (url.includes('nvidia') ? 'nvidia' : url.includes('openrouter') ? 'openrouter' : url.includes('cerebras') ? 'cerebras' : url.includes('groq') ? 'groq' : 'other');
const ok = (text = 'answer') => JSON.stringify({ choices: [{ message: { content: text } }] });
type Reply = { status: number; body?: string; retryAfter?: string };
function fakeFetch(plan: Partial<Record<string, Reply | Reply[]>>) {
  const calls: Array<{ host: string; auth: string; body: any }> = [];
  const impl = async (url: string, init: RequestInit) => {
    const host = hostOf(url);
    calls.push({ host, auth: String((init.headers as Record<string, string>).Authorization), body: JSON.parse(String(init.body)) });
    const p = plan[host];
    const reply = Array.isArray(p) ? (p.length > 1 ? p.shift()! : p[0]!) : p ?? { status: 500 };
    return { status: reply.status, headers: { get: (n: string) => (n === 'retry-after' ? reply.retryAfter ?? null : null) }, text: async () => reply.body ?? '' };
  };
  return { calls, impl };
}

describe('the free-only route table', () => {
  it('holds exactly the routes verified free, and nothing a key alone could add', () => {
    expect(Object.keys(T12_ROUTES).sort()).toEqual(['cerebras', 'groq', 'nvidia', 'openrouter']);
    for (const h of T12_LANE_ROUTE_ORDER) expect(T12_ROUTES[h]).toBeDefined();
  });
  it.each(['together', 'deepseek', 'deepinfra', 'fireworks', 'siliconflow', 'perplexity', 'gemini', 'anthropic', 'openai', 'litellm', '__proto__', 'constructor'])(
    '%s is unreachable even with its key set',
    (host) => {
      const env = { [`${host.toUpperCase()}_API_KEY`]: 'k', TOGETHER_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' };
      expect(t12Target(host, env)).toBeNull();
    },
  );
  it('OpenRouter is a free id with a zero price cap, so a paid model is refused rather than billed', () => {
    const t = t12Target('openrouter', ALL_KEYS)!;
    expect(t.model).toMatch(/:free$/);
    expect(t.body).toEqual({ provider: { max_price: { prompt: 0, completion: 0 } } });
  });
  it('does not route the Cerebras model that is archived', () => {
    expect(t12Target('cerebras', ALL_KEYS)!.model).not.toBe('zai-glm-4.7');
  });
  it('every key goes only to its own host', () => {
    expect(t12Target('nvidia', ALL_KEYS)).toMatchObject({ key: 'nim-k' });
    expect(t12Target('groq', ALL_KEYS)).toMatchObject({ key: 'gq-k' });
    expect(t12Target('nvidia', { NVIDIA_API_KEY: 'a', NVIDIA_NIM_API_KEY: 'b' })).toMatchObject({ key: 'a' });
  });
});

describe('cooldown policy', () => {
  it('honours Retry-After on a 429', () => expect(cooldownFor({ status: 429, reason: 'rate_limited', retryAfterMs: 30_500 })).toBe(31));
  it('defaults a 429 with no header', () => expect(cooldownFor({ status: 429, reason: 'rate_limited' })).toBe(COOLDOWN_SECONDS.rateLimited));
  it.each([401, 402, 403, 404, 410])('treats %i as misconfigured', (status) => expect(cooldownFor({ status, reason: `http_${status}` })).toBe(COOLDOWN_SECONDS.misconfigured));
  it.each([[500, 'http_500'], [null, 'timeout'], [null, 'network_error'], [200, 'empty_answer']])('treats %s %s as transient', (status, reason) => {
    expect(cooldownFor({ status: status as number | null, reason: reason as string })).toBe(COOLDOWN_SECONDS.transient);
  });
  it.each(['answered', 'no_credentials', 'egress_refused'])('does not cool on %s', (reason) => expect(cooldownFor({ status: null, reason })).toBeNull());
  it('a misconfigured route outlasts a rate limit, which outlasts a blip', () => {
    expect(COOLDOWN_SECONDS.misconfigured).toBeGreaterThan(COOLDOWN_SECONDS.rateLimited);
    expect(COOLDOWN_SECONDS.rateLimited).toBeGreaterThan(COOLDOWN_SECONDS.transient);
  });
});

describe('what a non-answer means', () => {
  it('no host tried is configuration, not a provider problem', () => {
    expect(askFailure({ outcome: 'NOT_CHECKED', host: null, tried: [], text: null })).toMatchObject({ kind: 'infra' });
  });
  it('hosts tried and refused can be routed around', () => {
    expect(askFailure({ outcome: 'NOT_CHECKED', host: null, tried: ['groq'], text: null })).toMatchObject({ kind: 'route_failed' });
  });
  it('an answer is not a failure', () => expect(askFailure({ outcome: 'answered', host: 'groq', tried: ['groq'], text: 'x' })).toBeNull());
});

const PG = process.env.T12_LANES_PG_URL;
const describePg = PG ? describe : describe.skip;
if (!PG) {
  // eslint-disable-next-line no-console
  console.warn('[t12-lane-routing] NOT_CHECKED: the durable routing block needs T12_LANES_PG_URL (a throwaway Postgres).');
}

describePg('routing on real Postgres', () => {
  let pool: Pool;
  let db: TxDb;
  const L1 = 'trinity-lane-1';
  const L2 = 'trinity-lane-2';
  const L3 = 'trinity-lane-3';
  const GROQ_ONLY = { T12_FREE_WAVE: 'true', GROQ_API_KEY: 'gq-k' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 16 });
    db = poolDb(pool as never);
    await pool.query(readFileSync(join(__dirname, 'fixtures/t12-lanes-schema.sql'), 'utf8'));
  });
  afterAll(async () => pool.end());
  beforeEach(async () => pool.query('TRUNCATE trinity_tasks RESTART IDENTITY; TRUNCATE agent_resource_claims RESTART IDENTITY'));

  const claimOne = async (lane: string, id: string): Promise<Handle> => {
    await replenish(db, [spec(id)], 50);
    const c = await claimMake(db, lane);
    if (c.kind !== 'claimed') throw new Error(`expected a claim: ${c.reason}`);
    return c.handle;
  };
  const events = async (id: number) => (await readLaneState(pool, id)).state.receipts.filter((r) => r.event === 'route_attempt');

  it('1. a Groq 429 is not asked again during its cooldown, by this or any later process', async () => {
    const { calls, impl } = fakeFetch({ groq: { status: 429, retryAfter: '600' } });
    const h = await claimOne(L1, 'g1');
    const ask = createRoutedAsk(db, { env: GROQ_ONLY, fetchImpl: impl as never });
    expect(await ask('p', h)).toMatchObject({ outcome: 'rate_limited', host: 'groq' });
    expect(await ask('p', h)).toMatchObject({ outcome: 'no_capacity' });

    const freshPool = new Pool({ connectionString: PG, max: 2 });
    try {
      const fresh = poolDb(freshPool as never);
      const later = createRoutedAsk(fresh, { env: GROQ_ONLY, fetchImpl: impl as never });
      expect(await later('p', h)).toMatchObject({ outcome: 'no_capacity' });
      expect((await coolingProviders(fresh)).has('groq')).toBe(true);
    } finally {
      await freshPool.end();
    }
    expect(calls).toHaveLength(1);
  });

  it('a 429 stops that wave: no second host is called in the same ask', async () => {
    const { calls, impl } = fakeFetch({ nvidia: { status: 429 }, openrouter: { status: 200, body: ok() } });
    const h = await claimOne(L1, 'stop');
    const out = await createRoutedAsk(db, { env: ALL_KEYS, fetchImpl: impl as never })('p', h);
    expect(out.outcome).toBe('rate_limited');
    expect(calls.map((c) => c.host)).toEqual(['nvidia']);
  });

  it('a cooldown ending puts the host back in rotation', async () => {
    const { calls, impl } = fakeFetch({ groq: { status: 200, body: ok() } });
    await coolProvider(pool, 'groq', 1, 'rate_limited');
    await pool.query(`UPDATE agent_resource_claims SET expires_at = now() - interval '1 second', claimed_at = now() - interval '1 hour'`);
    const h = await claimOne(L1, 'back');
    expect(await createRoutedAsk(db, { env: GROQ_ONLY, fetchImpl: impl as never })('p', h)).toMatchObject({ outcome: 'answered', host: 'groq' });
    expect(calls).toHaveLength(1);
  });

  it('2. another verified free provider serves the work, within its own limits', async () => {
    const { calls, impl } = fakeFetch({ nvidia: { status: 429 }, openrouter: { status: 200, body: ok('from openrouter') } });
    const ask = createRoutedAsk(db, { env: ALL_KEYS, fetchImpl: impl as never });
    const h = await claimOne(L1, 'next');
    expect((await ask('p', h)).outcome).toBe('rate_limited');
    const second = await ask('p', h);
    expect(second).toMatchObject({ outcome: 'answered', host: 'openrouter', text: 'from openrouter' });
    expect(calls.map((c) => c.host)).toEqual(['nvidia', 'openrouter']);
    expect(calls[1]!.auth).toBe('Bearer or-k');
    expect(calls[1]!.body).toMatchObject({ model: expect.stringMatching(/:free$/), provider: { max_price: { prompt: 0, completion: 0 } } });
  });

  it('non-429 failover is bounded per ask, and each failed host cools', async () => {
    const { calls, impl } = fakeFetch({ nvidia: { status: 500 }, openrouter: { status: 500 }, cerebras: { status: 500 }, groq: { status: 500 } });
    const ask = createRoutedAsk(db, { env: ALL_KEYS, fetchImpl: impl as never });
    const h = await claimOne(L1, 'bound');
    await ask('p', h);
    expect(calls).toHaveLength(MAX_HOSTS_PER_ASK);
    await ask('p', h);
    expect(await ask('p', h)).toMatchObject({ outcome: 'no_capacity' });
    expect(calls.map((c) => c.host).sort()).toEqual(['cerebras', 'groq', 'nvidia', 'openrouter']);
  });

  it('a route refused for its key stays out far longer than a rate limit', async () => {
    const { impl } = fakeFetch({ groq: { status: 401 } });
    const h = await claimOne(L1, 'badkey');
    await createRoutedAsk(db, { env: GROQ_ONLY, fetchImpl: impl as never })('p', h);
    const { rows } = await pool.query(`SELECT expires_at > now() + interval '5 hours' AS long FROM agent_resource_claims`);
    expect(rows[0].long).toBe(true);
  });

  const makeVia = (env: Record<string, string>, impl: unknown): LaneAdapters => {
    const ask = createRoutedAsk(db, { env, fetchImpl: impl as never });
    return {
      make: async (h) => {
        const a = await ask('p', h);
        return askFailure(a) ?? { ok: true, submission: { branch: `t12/${h.spec.id}`, commit: `c-${h.spec.id}`, base: 'b', files: h.spec.paths, host: a.host } };
      },
      check: async (h): Promise<Verdict> => ({ outcome: 'approved', commit: h.submission!.commit, transcript: 'node --test exited 0; the control exited 1 as it should.', evidence: {} }),
      publish: async () => ({ url: 'https://example.test/pr' }),
    };
  };
  const opts = (adapters: LaneAdapters, specs: LaneSpec[], over: object = {}) => ({
    db, lanes: [L1, L2, L3], adapters, publishEnabled: false, specs: () => specs, readyTarget: specs.length, heartbeatMs: 50, idleMs: 20, ...over,
  });

  it('3. every provider unavailable is a durable waiting state, and costs the task nothing', async () => {
    for (const h of T12_LANE_ROUTE_ORDER) await coolProvider(pool, h, 900, 'rate_limited');
    const { calls, impl } = fakeFetch({});
    const report = await runLanes(opts(makeVia(ALL_KEYS, impl), [spec('w1')]));
    expect(calls).toEqual([]);
    expect(report.paused).toContain('WAITING_FOR_CAPACITY');
    expect(report.waiting).toBe(1);

    const { rows } = await pool.query(`SELECT status, claim_count, stuck_reason, claimed_by, final_verdict FROM trinity_tasks`);
    expect(rows[0]).toMatchObject({ status: 'pending', claim_count: 0, claimed_by: null, final_verdict: null });
    expect(rows[0].stuck_reason).toContain('WAITING_FOR_CAPACITY');
    const { state } = await readLaneState(pool, 1);
    expect(state).toMatchObject({ stage: 'waiting_for_capacity', attempts: 0 });

    // Not offered again until the cooldown ends, so a later run does not spin on it.
    expect((await claimMake(db, L1)).kind).toBe('none');
    await pool.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12,notBefore}', to_jsonb((now() - interval '1 second')::text))`);
    const back = await claimMake(db, L1);
    expect(back.kind).toBe('claimed');
    const after = await readLaneState(pool, 1);
    expect(after.state.notBefore).toBeUndefined();
    expect((await pool.query('SELECT stuck_reason FROM trinity_tasks')).rows[0].stuck_reason).toBeNull();
    expect(verifyReceipts(after.state.receipts).ok).toBe(true);
  }, 30_000);

  it('4. a rate limit on one provider does not stop unrelated lanes', async () => {
    const { calls, impl } = fakeFetch({ nvidia: { status: 429 }, openrouter: { status: 200, body: ok() }, cerebras: { status: 200, body: ok() }, groq: { status: 200, body: ok() } });
    const specs = [spec('l1'), spec('l2'), spec('l3')];
    const report = await runLanes(opts(makeVia(ALL_KEYS, impl), specs));
    expect(report).toMatchObject({ made: 3, approved: 3, paused: null, waiting: 0 });
    expect(calls.filter((c) => c.host === 'nvidia').length).toBe(1);
  }, 30_000);

  it('4b. with no model capacity at all, checks still finish', async () => {
    await replenish(db, [spec('done1'), spec('later')], 2);
    const c = await claimMake(db, L1);
    if (c.kind !== 'claimed') throw new Error('claim');
    await submit(db, c.handle, { branch: 'b', commit: 'c-done1', base: 'b', files: c.handle.spec.paths, host: 'groq' });
    for (const h of T12_LANE_ROUTE_ORDER) await coolProvider(pool, h, 900, 'rate_limited');
    const { impl } = fakeFetch({});
    const report = await runLanes(opts(makeVia(ALL_KEYS, impl), [spec('done1'), spec('later')], { lanes: [L2, L3] }));
    expect(report).toMatchObject({ approved: 1, waiting: 1 });
    expect(report.paused).toContain('WAITING_FOR_CAPACITY');
  }, 30_000);

  it('5. every route attempt records provider, model, reason, status, cooldown and task id', async () => {
    const { impl } = fakeFetch({ nvidia: { status: 500 }, openrouter: { status: 429, retryAfter: '60' } });
    const h = await claimOne(L1, 'audit');
    await createRoutedAsk(db, { env: ALL_KEYS, fetchImpl: impl as never })('p', h);
    const rows = await events(h.taskId);
    expect(rows.map((r: DecisionReceipt) => r.evidence)).toEqual([
      expect.objectContaining({ provider: 'nvidia', model: T12_ROUTES.nvidia!.model, reason: 'http_500', status: 500, cooldown_until: expect.any(String), task_id: h.taskId }),
      expect.objectContaining({ provider: 'openrouter', model: T12_ROUTES.openrouter!.model, reason: 'rate_limited', status: 429, cooldown_until: expect.any(String), task_id: h.taskId }),
    ]);
    expect(verifyReceipts((await readLaneState(pool, h.taskId)).state.receipts).ok).toBe(true);
  });

  it('a success records no cooldown', async () => {
    const { impl } = fakeFetch({ groq: { status: 200, body: ok() } });
    const h = await claimOne(L1, 'fine');
    await createRoutedAsk(db, { env: GROQ_ONLY, fetchImpl: impl as never })('p', h);
    expect((await events(h.taskId))[0]!.evidence).toMatchObject({ provider: 'groq', reason: 'answered', status: 200, cooldown_until: null });
    expect((await coolingProviders(pool)).size).toBe(0);
  });

  it('a stale worker cannot add to the route record', async () => {
    const { impl } = fakeFetch({ groq: { status: 200, body: ok() } });
    const h = await claimOne(L1, 'stale');
    await pool.query(`UPDATE trinity_tasks SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.taskId]);
    await createRoutedAsk(db, { env: GROQ_ONLY, fetchImpl: impl as never })('p', h);
    expect(await events(h.taskId)).toEqual([]);
  });

  it('a cooldown row survives the production CHECK on resource_kind and stays one row', async () => {
    await coolProvider(pool, 'groq', 60, 'a');
    await coolProvider(pool, 'groq', 120, 'b');
    const { rows } = await pool.query(`SELECT count(*)::int AS n, min(purpose) AS p FROM agent_resource_claims WHERE resource_id = 'llm_cooldown:groq'`);
    expect(rows[0]).toEqual({ n: 1, p: 'b' });
    expect(LANE_POOL).toBe('trinity-t12-lanes');
  });

  it('a later, shorter cooldown cannot shorten an active one', async () => {
    await coolProvider(pool, 'groq', 3600, 'long');
    const first = (await coolingProviders(pool)).get('groq')!;
    await coolProvider(pool, 'groq', 10, 'short');
    expect((await coolingProviders(pool)).get('groq')).toBe(first);
  });

  it('claimStage is unaffected by route state', async () => {
    expect(await claimStage(db, 'awaiting_check', L1)).toBeNull();
    expect(typeof recordVerdict).toBe('function');
  });
});
