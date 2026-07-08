/**
 * Live-numbers public observability endpoints (2026-07-07).
 *
 * Verifies the response SHAPE + honesty rules the TrustShell.dev frontend
 * depends on:
 *   GET /api/v1/agents/minted
 *     - each row shape { name, display_name, agent_id, erc8004_token_id,
 *       current_repid, tier } + count,
 *     - adversarial mock agents (agent_id 'trinity-agent-mock-%') excluded by
 *       default; ?include_mock=true opts them back in,
 *     - a query error surfaces as 500 (fail-loud, not silent empty).
 *   GET /api/v1/observability/onchain-stats
 *     - real counts { agents_minted, lifetime_onchain_writes, as_of },
 *     - mock agents excluded from agents_minted by default,
 *     - lifetime_onchain_writes is the real erc8004_reputation_writes row count.
 *
 * db is mocked via a call-time global handle (no jest hoist/TDZ). No auth
 * middleware is mounted, matching the pre-auth public mount in src/index.ts.
 */
jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__obsPublicDb;
  },
}));

import request from 'supertest';
import express from 'express';
import observabilityPublicRouter from '../src/routes/v1/observability-public';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', observabilityPublicRouter);
  return app;
}

/**
 * agents/minted uses: db.from(t).select(cols).not(col,op,val).order(col,opts) → await.
 * The terminal await resolves via the thenable `order()`.
 */
function makeMintedDb(result: { data: any[] | null; error: any }) {
  const builder: any = {
    select: () => builder,
    not: () => builder,
    order: () => Promise.resolve(result),
  };
  return { from: () => builder };
}

/**
 * onchain-stats issues TWO queries against different tables:
 *   repid_agents:              from().select('agent_id').not(...)              → await (thenable via not())
 *   erc8004_reputation_writes: from().select('*',{count,head}) (head count)    → await (thenable via select())
 * Route by table name.
 */
function makeStatsDb(opts: {
  mintedRows: { agent_id: string | null }[] | null;
  mintedErr?: any;
  writesCount: number | null;
  writesErr?: any;
}) {
  return {
    from: (table: string) => {
      if (table === 'erc8004_reputation_writes') {
        // head:true count query — select() is terminal (awaited directly).
        const b: any = {
          select: () => Promise.resolve({ count: opts.writesCount, error: opts.writesErr ?? null }),
        };
        return b;
      }
      // repid_agents — select().not() is terminal.
      const b: any = {
        select: () => b,
        not: () => Promise.resolve({ data: opts.mintedRows, error: opts.mintedErr ?? null }),
      };
      return b;
    },
  };
}

const REAL_AGENT = {
  agent_name: 'trinity-shofet',
  display_name: null,
  agent_id: 'trinity-shofet',
  erc8004_token_id: '5863',
  current_repid: 1390,
  tier: 'ESTABLISHED',
  lifecycle_status: 'active',
};
const MOCK_AGENT = {
  agent_name: 'trinity-test adversarial agent',
  display_name: null,
  agent_id: 'trinity-agent-mock-001',
  erc8004_token_id: '9999',
  current_repid: 100,
  tier: 'PROBATIONARY',
  lifecycle_status: 'deprecated',
};

describe('GET /api/v1/agents/minted', () => {
  test('returns real minted agents in the documented shape, mock excluded by default', async () => {
    (global as any).__obsPublicDb = makeMintedDb({ data: [REAL_AGENT, MOCK_AGENT], error: null });
    const res = await request(makeApp()).get('/api/v1/agents/minted');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(res.body.agents[0]).toEqual({
      name: 'trinity-shofet',
      display_name: 'trinity-shofet', // falls back to agent_name when display_name is null
      agent_id: 'trinity-shofet',
      erc8004_token_id: '5863',
      current_repid: 1390,
      tier: 'ESTABLISHED',
    });
    // The mock adversarial agent must NOT appear on the public leaderboard.
    expect(res.body.agents.find((a: any) => a.agent_id === 'trinity-agent-mock-001')).toBeUndefined();
  });

  test('?include_mock=true opts the mock agents back in', async () => {
    (global as any).__obsPublicDb = makeMintedDb({ data: [REAL_AGENT, MOCK_AGENT], error: null });
    const res = await request(makeApp()).get('/api/v1/agents/minted?include_mock=true');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.agents.find((a: any) => a.agent_id === 'trinity-agent-mock-001')).toBeDefined();
  });

  test('fails loud with 500 on a query error (not a silent empty list)', async () => {
    (global as any).__obsPublicDb = makeMintedDb({ data: null, error: { message: 'boom' } });
    const res = await request(makeApp()).get('/api/v1/agents/minted');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
  });
});

describe('GET /api/v1/observability/onchain-stats', () => {
  test('returns real counts with mock excluded from agents_minted by default', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }, { agent_id: 'trinity-orch' }, { agent_id: 'trinity-agent-mock-001' }],
      writesCount: 46,
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');

    expect(res.status).toBe(200);
    expect(res.body.agents_minted).toBe(2); // mock-001 excluded
    expect(res.body.lifetime_onchain_writes).toBe(46);
    expect(typeof res.body.as_of).toBe('string');
  });

  test('?include_mock=true counts mock agents too', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }, { agent_id: 'trinity-agent-mock-001' }],
      writesCount: 46,
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats?include_mock=true');
    expect(res.status).toBe(200);
    expect(res.body.agents_minted).toBe(2);
  });

  test('fails loud with 500 when the writes count query errors', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }],
      writesCount: null,
      writesErr: { message: 'boom' },
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
  });
});
