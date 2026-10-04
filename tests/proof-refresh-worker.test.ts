/**
 * proof-refresh-worker — flag, selection, bound, and "a prover error never escapes".
 *
 * No real HTTP and no real database: every dependency is injected or mocked.
 */
jest.mock('../src/db', () => ({ db: { from: () => { throw new Error('db must not be touched in unit tests'); } } }));
jest.mock('../src/db/direct-pg', () => ({ pgQuery: () => { throw new Error('pg must not be touched in unit tests'); } }));
jest.mock('../src/services/emergency-halt', () => ({ shouldParkForHalt: () => Promise.resolve(false) }));

import {
  decide,
  runOnce,
  readConfig,
  startProofRefreshWorker,
  stopProofRefreshWorker,
  SELECT_CANDIDATES_SQL,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_AGENTS,
  type RefreshCandidate,
  type RefreshDeps,
  type RefreshConfig,
} from '../src/workers/proof-refresh-worker';
import { PROOF_FRESHNESS_MAX_AGE_DAYS } from '../src/zkp/proof-freshness';

const NOW = new Date('2026-10-04T08:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const CFG: RefreshConfig = { maxAgeDays: 6, maxAgents: 25, intervalMs: 6 * 3600_000 };

function cand(over: Partial<RefreshCandidate> = {}): RefreshCandidate {
  return {
    agent_id: 'a-1',
    agent_name: 'trinity-sophia',
    current_repid: 1299,
    last_proof_at: daysAgo(10),
    event_id: 'ev-1',
    repid_after: 1299,
    ...over,
  };
}

function makeDeps(rows: RefreshCandidate[], over: Partial<RefreshDeps> = {}) {
  const enqueued: any[] = [];
  const posts: any[] = [];
  const logs: string[] = [];
  const deps: RefreshDeps = {
    query: jest.fn(async () => rows),
    enqueue: jest.fn(async (row) => { enqueued.push(row); return { error: null }; }),
    fetchImpl: jest.fn(async (url: any, init: any) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    }) as any,
    proverUrl: 'https://prover.test/',
    isHalted: async () => false,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(`WARN ${m}`),
    ...over,
  };
  return { deps, enqueued, posts, logs };
}

beforeEach(() => {
  delete process.env.PROOF_REFRESH_ENABLED;
  delete process.env.PROOF_REFRESH_MAX_AGE_DAYS;
  delete process.env.PROOF_REFRESH_MAX_AGENTS;
  delete process.env.PROOF_REFRESH_INTERVAL_MS;
  stopProofRefreshWorker();
});
afterAll(() => stopProofRefreshWorker());

describe('flag off means no call', () => {
  it('runOnce touches nothing unless PROOF_REFRESH_ENABLED is exactly "true"', async () => {
    for (const v of [undefined, '1', 'yes', 'TRUE']) {
      if (v === undefined) delete process.env.PROOF_REFRESH_ENABLED; else process.env.PROOF_REFRESH_ENABLED = v;
      const { deps } = makeDeps([cand()]);
      const s = await runOnce(CFG, deps);
      expect(s.ran).toBe(false);
      expect(deps.query).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('the loop does not start when off, and starts (idempotently) when on', () => {
    expect(startProofRefreshWorker(CFG)).toBe(false);
    process.env.PROOF_REFRESH_ENABLED = 'true';
    expect(startProofRefreshWorker(CFG)).toBe(true);
    expect(startProofRefreshWorker(CFG)).toBe(true);
  });

  it('control: the same input DOES call through when the flag is on (the off-test is not vacuous)', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps, posts } = makeDeps([cand()]);
    const s = await runOnce(CFG, deps);
    expect(s.ran).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it('a set L0 halt parks the tick before any query', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps } = makeDeps([cand()], { isHalted: async () => true });
    const s = await runOnce(CFG, deps);
    expect(s.ran).toBe(false);
    expect(deps.query).not.toHaveBeenCalled();
  });
});

describe('selection logic', () => {
  it('refreshes a stale real proof, re-proving the CURRENT score bound to the latest event', () => {
    const [d] = decide([cand()], CFG, NOW);
    expect(d).toEqual({ action: 'refresh', agentId: 'a-1', agentName: 'trinity-sophia', score: 1299, eventId: 'ev-1' });
  });

  it('skips a proof younger than maxAgeDays', () => {
    expect(decide([cand({ last_proof_at: daysAgo(5.9) })], CFG, NOW)[0]).toMatchObject({ action: 'skip', reason: 'fresh' });
    expect(decide([cand({ last_proof_at: daysAgo(6.1) })], CFG, NOW)[0]).toMatchObject({ action: 'refresh' });
  });

  it('skips an agent with no prior real proof', () => {
    expect(decide([cand({ last_proof_at: null })], CFG, NOW)[0]).toMatchObject({ action: 'skip', reason: 'no_prior_real_proof' });
  });

  it('skips an agent with no score event to bind the job to', () => {
    expect(decide([cand({ event_id: null, repid_after: null })], CFG, NOW)[0]).toMatchObject({ reason: 'no_score_event' });
  });

  it('never proves a score the job cannot bind: latest event repid_after != current_repid → skip', () => {
    expect(decide([cand({ repid_after: 1200 })], CFG, NOW)[0]).toMatchObject({ action: 'skip', reason: 'score_mismatch' });
    // rounding matches the drain (Math.round of repid_after)
    expect(decide([cand({ current_repid: 1299, repid_after: 1299.4 })], CFG, NOW)[0]).toMatchObject({ action: 'refresh' });
  });

  it('takes the oldest proofs first', () => {
    const rows = [
      cand({ agent_id: 'newer', last_proof_at: daysAgo(8) }),
      cand({ agent_id: 'oldest', last_proof_at: daysAgo(30) }),
    ];
    const out = decide(rows, { ...CFG, maxAgents: 1 }, NOW);
    expect(out.find((d) => d.action === 'refresh')?.agentId).toBe('oldest');
  });

  it('the SQL selects real proofs only, the served-route predicate, oldest first, bounded, deduped', () => {
    expect(SELECT_CANDIDATES_SQL).toMatch(/z\.is_real IS TRUE/);
    expect(SELECT_CANDIDATES_SQL).toMatch(/z\.scheme = 'plonky3_range_check'/);
    expect(SELECT_CANDIDATES_SQL).toMatch(/z\.proof_bytes IS NOT NULL/);
    expect(SELECT_CANDIDATES_SQL).toMatch(/ORDER BY p\.last_proof_at ASC/);
    expect(SELECT_CANDIDATES_SQL).toMatch(/LIMIT \$2/);
    expect(SELECT_CANDIDATES_SQL).toMatch(/NOT EXISTS[\s\S]*repid_proof_queue/);
  });

  it('passes maxAgeDays, maxAgents and the dedupe window as bound parameters', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps } = makeDeps([]);
    await runOnce(CFG, deps);
    expect(deps.query).toHaveBeenCalledWith(SELECT_CANDIDATES_SQL, [6 * 86_400, 25, 6 * 3600]);
  });

  it('defaults: 6 days, 25 agents; env overrides; garbage falls back to defaults', () => {
    expect(readConfig()).toMatchObject({ maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxAgents: DEFAULT_MAX_AGENTS });
    expect(DEFAULT_MAX_AGE_DAYS).toBe(6);
    // refresh must fire BEFORE the served proof fails the freshness rule
    expect(DEFAULT_MAX_AGE_DAYS).toBeLessThan(PROOF_FRESHNESS_MAX_AGE_DAYS);
    expect(DEFAULT_MAX_AGENTS).toBe(25);
    process.env.PROOF_REFRESH_MAX_AGE_DAYS = '3';
    process.env.PROOF_REFRESH_MAX_AGENTS = '2';
    expect(readConfig()).toMatchObject({ maxAgeDays: 3, maxAgents: 2 });
    process.env.PROOF_REFRESH_MAX_AGENTS = '-5';
    expect(readConfig().maxAgents).toBe(25);
  });
});

describe('the bound is respected', () => {
  it('never enqueues or POSTs more than maxAgents, even if the query returns more', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const rows = Array.from({ length: 40 }, (_, i) => cand({ agent_id: `a-${i}`, last_proof_at: daysAgo(10 + i) }));
    const { deps, enqueued, posts } = makeDeps(rows);
    const s = await runOnce({ ...CFG, maxAgents: 3 }, deps);
    expect(enqueued).toHaveLength(3);
    expect(posts).toHaveLength(3);
    expect(s.skipped.over_bound).toBe(37);
  });

  it('writes only the queue row and the prover POST, with the same shape the score route sends', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps, enqueued, posts } = makeDeps([cand()]);
    await runOnce(CFG, deps);
    expect(enqueued[0]).toMatchObject({ agent_id: 'a-1', event_id: 'ev-1', status: 'pending', zkp_service_url: 'https://prover.test' });
    expect(posts[0].url).toBe('https://prover.test/zkp/repid-proof');
    expect(posts[0].body).toEqual({ agent_id: 'a-1', score: 1299, metadata: { job_id: enqueued[0].job_id, refresh: true } });
  });

  it('does not POST when the queue insert fails', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps, posts, logs } = makeDeps([cand()], { enqueue: async () => ({ error: { message: 'boom' } }) });
    const s = await runOnce(CFG, deps);
    expect(posts).toHaveLength(0);
    expect(s.enqueued).toBe(0);
    expect(logs.some((l) => l.includes('enqueue failed'))).toBe(true);
  });
});

describe('a postcard error is logged and never thrown into the server', () => {
  it('prover throws → logged, counted, tick resolves, next agent still processed', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    let n = 0;
    const { deps, logs } = makeDeps([cand({ agent_id: 'x' }), cand({ agent_id: 'y', last_proof_at: daysAgo(9) })], {
      fetchImpl: (async () => { n++; if (n === 1) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 } as Response; }) as any,
    });
    const s = await runOnce(CFG, deps);
    expect(s.proverFailed).toBe(1);
    expect(s.proverOk).toBe(1);
    expect(logs.some((l) => l.startsWith('WARN') && l.includes('ECONNREFUSED'))).toBe(true);
  });

  it('prover non-2xx → logged as failure, not thrown', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps, logs } = makeDeps([cand()], { fetchImpl: (async () => ({ ok: false, status: 503 }) as Response) as any });
    const s = await runOnce(CFG, deps);
    expect(s.proverFailed).toBe(1);
    expect(logs.some((l) => l.includes('HTTP 503'))).toBe(true);
  });

  it('the candidate query throwing is caught too', async () => {
    process.env.PROOF_REFRESH_ENABLED = 'true';
    const { deps, logs } = makeDeps([], { query: async () => { throw new Error('circuit open'); } });
    await expect(runOnce(CFG, deps)).resolves.toBeDefined();
    expect(logs.some((l) => l.includes('tick failed: circuit open'))).toBe(true);
  });
});
