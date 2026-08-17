/**
 * METRICS TRUTH — GET /api/v1/metrics must publish measurements, not literals.
 *
 * This is a red-before-green guard on the public metrics surface. Against the
 * pre-fix handler in src/index.ts every scenario below fails, and it fails for the
 * reason the fix exists: the payload carried `hal_approval_rate: 99.4` regardless of
 * what the HAL ledger said, counted rows client-side so a large table reported a
 * truncated count, and rendered a failed query as `0` via `data?.length || 0`.
 *
 * WHY THE ROUTE AND NOT THE MODULE. The live handler for this path is registered in
 * src/index.ts BEFORE the /api/v1 router is mounted, so the /metrics block inside
 * src/routes/v1.ts is shadowed and unreachable — Express matches in registration
 * order. Testing the module alone would have proved nothing about what the public
 * endpoint returns, and testing the v1 router would have tested dead code. This
 * suite drives the real app through supertest for that reason: the thing itself,
 * not a proxy for it.
 */

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__metricsDb;
  },
}));

import request from 'supertest';
import app from '../src/index';
import { resetMetricsCache } from '../src/services/metrics-snapshot';

/** What a query looked like by the time it was awaited. */
interface QueryState {
  table: string;
  head: boolean;
  cols: string;
  filters: string[];
}

type Script = (q: QueryState) => { data?: any; error?: any; count?: number | null };

/**
 * supabase-js-shaped stub. It answers BOTH the old handler's call style
 * (`select(cols)` then await, counted in JS) and the new one's
 * (`select('*', { count: 'exact', head: true })`), so this one file is a meaningful
 * test on either side of the fix rather than a rewrite that only ever saw green.
 */
function makeDb(script: Script) {
  return {
    from(table: string) {
      const q: QueryState = { table, head: false, cols: '', filters: [] };
      const b: any = {
        select(cols?: string, opts?: any) {
          q.cols = cols ?? '';
          if (opts && opts.head) q.head = true;
          return b;
        },
        not(col: string) {
          q.filters.push(`not:${col}`);
          return b;
        },
        eq(col: string) {
          q.filters.push(`eq:${col}`);
          return b;
        },
        gt(col: string) {
          q.filters.push(`gt:${col}`);
          return b;
        },
        limit() {
          return b;
        },
        then(onOk: any, onErr: any) {
          const r = script(q);
          return Promise.resolve({
            data: r.data ?? null,
            error: r.error ?? null,
            count: r.count ?? null,
          }).then(onOk, onErr);
        },
      };
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

/**
 * A database whose real contents disagree with every literal the old payload shipped.
 * HAL decisions here are 1 vetoed + 1 clean — a 50% approval rate, against the
 * hardcoded 99.4.
 */
const HEALTHY: Script = (q) => {
  if (q.table === 'repid_agents') {
    if (q.head) return { count: 176 };
    return { data: [{ vdr_count: 3000 }, { vdr_count: 195 }] };
  }
  if (q.table === 'llm_call_log') {
    return {
      data: [
        { provider: 'anthropic', latency_ms: 800, status: 'success' },
        { provider: 'openai', latency_ms: 900, status: 'success' },
        // A failed call: its latency measures the failure, not the service, and must
        // not be averaged into the response time.
        { provider: 'openai', latency_ms: 30000, status: 'error' },
      ],
    };
  }
  if (q.table === 'repid_score_events') {
    if (q.head) {
      if (q.filters.some((f) => f.includes('llm_provider'))) return { count: 147165 };
      if (q.filters.some((f) => f.includes('hallucination_caught'))) return { count: 70023 };
      return { count: 152162 };
    }
    if (q.cols.includes('hal_decision')) {
      return { data: [{ hal_decision: 'vetoed' }, { hal_decision: 'clean' }] };
    }
    if (q.cols.includes('agent_id')) {
      return { data: [{ agent_id: 'a' }, { agent_id: 'a' }, { agent_id: 'b' }] };
    }
    // The old handler's row-counting queries.
    return { data: [] };
  }
  return { data: [], count: 0 };
};

/** Every query errors — the scenario the old `|| 0` fallback turned into a zero. */
const ALL_QUERIES_FAIL: Script = () => ({ error: { message: 'connection refused' } });

/** Healthy, except no HAL decision was recorded in the window. */
const NO_HAL_DECISIONS: Script = (q) => {
  if (q.table === 'repid_score_events' && !q.head && q.cols.includes('hal_decision')) {
    return { data: [] };
  }
  return HEALTHY(q);
};

async function getMetrics(script: Script) {
  (global as any).__metricsDb = makeDb(script);
  resetMetricsCache();
  return request(app).get('/api/v1/metrics');
}

describe('GET /api/v1/metrics publishes measurements, not literals', () => {
  test('every number reflects the database, and none is a hardcoded constant', async () => {
    const res = await getMetrics(HEALTHY);
    expect(res.status).toBe(200);

    // THE HEADLINE. 99.4 was published no matter what HAL had decided. The stubbed
    // ledger is 1 veto + 1 clean, so the only honest approval rate is 50%.
    expect(res.body.hal_approval_rate).toBe(50);
    expect(res.body.hal_veto_rate_24h).toBe(0.5);

    // Counts come from Postgres, not from counting a truncated page of rows in JS.
    // The stub returns 2 agent rows but reports an exact count of 176; the old code
    // published 2.
    expect(res.body.agents).toBe(176);
    expect(res.body.decisions).toBe(147165);
    expect(res.body.hallucinations).toBe(70023);

    expect(res.body.vdr).toBe(3195);
    expect(res.body.providers).toBe(2);
    expect(res.body.active_agents_24h).toBe(2);
    // (800 + 900) / 2 — the 30s failed call is excluded.
    expect(res.body.avg_response_ms).toBe(850);
    expect(res.body.hallucination_catch_rate).toBe(0.4602);
  });

  test('a status constant that cannot report failure is not published', async () => {
    const res = await getMetrics(HEALTHY);
    // `status: "operational"` had no code path to any other value. Per-field
    // provenance replaces it, and that CAN go bad.
    expect(res.body.status).toBeUndefined();
    expect(res.body.system).toBeUndefined();
    expect(typeof res.body.measurement).toBe('object');
  });

  test('a failed query is reported as failed, never as zero', async () => {
    const res = await getMetrics(ALL_QUERIES_FAIL);
    expect(res.status).toBe(200);

    // The old handler answered `agents: 0` here — a database outage rendered as a
    // confident measurement. A consumer cannot tell that apart from an empty table.
    expect(res.body.agents).toBeNull();
    expect(res.body.decisions).toBeNull();
    expect(res.body.hallucinations).toBeNull();
    expect(res.body.vdr).toBeNull();
    expect(res.body.providers).toBeNull();
    expect(res.body.avg_response_ms).toBeNull();
    expect(res.body.hal_approval_rate).toBeNull();

    expect(res.body.measurement.agents.status).toBe('failed');
    expect(typeof res.body.measurement.agents.reason).toBe('string');
    expect(res.body.measurement.hal_approval_rate.status).toBe('failed');
  });

  test('an empty window is unmeasured, not a rate of zero and not 99.4', async () => {
    const res = await getMetrics(NO_HAL_DECISIONS);
    expect(res.body.hal_approval_rate).toBeNull();
    expect(res.body.hal_veto_rate_24h).toBeNull();
    expect(res.body.measurement.hal_approval_rate.status).toBe('unmeasured');
    expect(res.body.measurement.hal_approval_rate.reason).toMatch(/no HAL decisions/i);
    // Counts that DID resolve are unaffected — one absent measurement must not
    // suppress the ones that were genuinely taken.
    expect(res.body.agents).toBe(176);
  });

  test('null means unmeasured and a number means measured — the two never blur', async () => {
    for (const script of [HEALTHY, ALL_QUERIES_FAIL, NO_HAL_DECISIONS]) {
      const res = await getMetrics(script);
      const m = res.body.measurement;
      expect(Object.keys(m).length).toBeGreaterThan(0);
      for (const [field, entry] of Object.entries<any>(m)) {
        expect(['measured', 'unmeasured', 'failed']).toContain(entry.status);
        if (entry.status === 'measured') {
          expect(typeof res.body[field]).toBe('number');
        } else {
          expect(res.body[field]).toBeNull();
          // An absent measurement always says why.
          expect(typeof entry.reason).toBe('string');
        }
      }
    }
  });

  test('every measured rate states the denominator it was taken over', async () => {
    const res = await getMetrics(HEALTHY);
    const m = res.body.measurement;
    // A rate without its basis is not a result: 50% over 2 decisions and 50% over
    // 20,000 are different claims.
    expect(m.hal_approval_rate.basis).toBe(2);
    expect(m.hal_veto_rate_24h.basis).toBe(2);
    expect(m.avg_response_ms.basis).toBe(2);
    expect(m.hallucination_catch_rate.basis).toBe(152162);
    expect(m.hal_approval_rate.window).toBe('24h');
    expect(m.hallucination_catch_rate.window).toBe('all_time');
  });

  test('process uptime is real process state, and is not an availability percentage', async () => {
    const res = await getMetrics(HEALTHY);
    // `uptime_pct: 99.9` claimed to know about time the process was NOT running.
    expect(res.body.uptime_pct).toBeUndefined();
    expect(typeof res.body.process_uptime_s).toBe('number');
    expect(res.body.measurement.process_uptime_s.source).toBe('process.uptime()');
  });

  test('the contract addresses stay — an identifier is not a measurement', async () => {
    const res = await getMetrics(HEALTHY);
    // docs/USER_GUIDE_FIRST_5_MINUTES.md tells users this endpoint publishes the
    // staking address, and tests/e2e/reponomics-live-flow.e2e.ts reads `agents` and
    // `vdr` as numbers. Both contracts are preserved.
    expect(res.body.staking_contract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.identity_registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.measurement.staking_contract).toBeUndefined();
  });
});
