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
 *     - real counts { agents_minted, lifetime_onchain_writes,
 *       onchain_writes_excluded_unverifiable, as_of },
 *     - mock agents excluded from agents_minted by default,
 *     - lifetime_onchain_writes counts ONLY rows verifiable on basescan: a real
 *       0x+64-hex tx_hash AND the canonical ReputationRegistry. The landing page
 *       prints this under "Live on Base Sepolia. Receipts, not promises." next to
 *       "(verifiable on basescan)", so a row that cannot be looked up must not be
 *       in it. The unfiltered count over-claimed by 13 on 2026-09-13 (106 vs 93):
 *       5 placeholder `0xmock_reputation_tx_…` rows and 8 rows on the
 *       IdentityRegistry 0x8004A818… rather than the ReputationRegistry.
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
 *   erc8004_reputation_writes: from().select('tx_hash, contract_address')       → await (thenable via select())
 * Route by table name.
 */
function makeStatsDb(opts: {
  mintedRows: { agent_id: string | null }[] | null;
  mintedErr?: any;
  writeRows: { tx_hash: string | null; contract_address: string | null }[] | null;
  writesErr?: any;
}) {
  return {
    from: (table: string) => {
      if (table === 'erc8004_reputation_writes') {
        // row select — select() is terminal (awaited directly).
        const b: any = {
          select: () => Promise.resolve({ data: opts.writeRows, error: opts.writesErr ?? null }),
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

// The canonical registries for the default network (base-sepolia). The second is
// the IdentityRegistry — a REAL contract, which is exactly why rows on it look
// legitimate until you check which contract the public label names.
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const realTx = (n: number) => '0x' + n.toString(16).padStart(64, '0');

describe('GET /api/v1/observability/onchain-stats', () => {
  test('returns real counts with mock excluded from agents_minted by default', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }, { agent_id: 'trinity-orch' }, { agent_id: 'trinity-agent-mock-001' }],
      writeRows: [
        { tx_hash: realTx(1), contract_address: REPUTATION_REGISTRY },
        { tx_hash: realTx(2), contract_address: REPUTATION_REGISTRY },
      ],
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');

    expect(res.status).toBe(200);
    expect(res.body.agents_minted).toBe(2); // mock-001 excluded
    expect(res.body.lifetime_onchain_writes).toBe(2);
    expect(res.body.onchain_writes_excluded_unverifiable).toBe(0);
    expect(typeof res.body.as_of).toBe('string');
  });

  // The regression this endpoint actually shipped: the live table on 2026-09-13
  // held 106 rows and the page published all of them as basescan-verifiable
  // "reputation writes". Only 93 were.
  test('excludes placeholder tx rows and rows on a different contract', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }],
      writeRows: [
        { tx_hash: realTx(1), contract_address: REPUTATION_REGISTRY },
        { tx_hash: realTx(2), contract_address: REPUTATION_REGISTRY },
        // 5-row class: a literal placeholder. Starts '0x', so any prefix-only
        // check passes it; nothing to look up on basescan.
        { tx_hash: '0xmock_reputation_tx_1778537971178', contract_address: REPUTATION_REGISTRY },
        // 8-row class: a real tx, but on the IdentityRegistry — a mint, not a
        // reputation write, and not the contract the public label names.
        { tx_hash: realTx(3), contract_address: IDENTITY_REGISTRY },
        // Defensive: a row with no tx at all.
        { tx_hash: null, contract_address: REPUTATION_REGISTRY },
      ],
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');

    expect(res.status).toBe(200);
    expect(res.body.lifetime_onchain_writes).toBe(2);
    expect(res.body.onchain_writes_excluded_unverifiable).toBe(3);
  });

  test('matches the contract address case-insensitively', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }],
      writeRows: [{ tx_hash: realTx(1), contract_address: REPUTATION_REGISTRY.toLowerCase() }],
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');
    expect(res.status).toBe(200);
    expect(res.body.lifetime_onchain_writes).toBe(1);
  });

  test('?include_mock=true counts mock agents too', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }, { agent_id: 'trinity-agent-mock-001' }],
      writeRows: [{ tx_hash: realTx(1), contract_address: REPUTATION_REGISTRY }],
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats?include_mock=true');
    expect(res.status).toBe(200);
    expect(res.body.agents_minted).toBe(2);
  });

  test('fails loud with 500 when the writes query errors', async () => {
    (global as any).__obsPublicDb = makeStatsDb({
      mintedRows: [{ agent_id: 'trinity-shofet' }],
      writeRows: null,
      writesErr: { message: 'boom' },
    });
    const res = await request(makeApp()).get('/api/v1/observability/onchain-stats');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query_failed');
  });
});
