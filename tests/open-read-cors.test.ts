/**
 * Open CORS for the PUBLIC READ endpoints the stranger path needs — and ONLY those.
 *
 * THE BUG. The global CORS allow-list answered any non-allow-listed Origin with an Error, which
 * Express renders as a 500 HTML page. The browser extension's RepID lookup worked only because
 * host_permissions makes Chrome omit the Origin header (the allow-list waves a missing Origin
 * through). A content script, or a Chrome that sends `chrome-extension://…`, or any other website
 * got the 500 and the UI said "Proof not checked". Nothing was red: server tests call routes
 * without an Origin.
 *
 * WHY THIS RUNS THE REAL APP (`src/index.ts`), not a copy of its CORS config. The property is
 * "these listed routes answer any Origin AND the allow-list still guards everything else, in the
 * real middleware order". A test that builds its own express app with its own cors() proves the
 * helper, not the engine, and goes on passing if someone un-wraps the line in index.ts.
 *
 * TWO HALVES, both required — a test that only proves the doors open passes when everything is open:
 *   1. every listed read, from a chrome-extension / arbitrary / `null` Origin: 200 + ACAO `*`,
 *      no credentials header;
 *   2. mutating / spend / mint / stake routes, and the sibling reads that are NOT listed, still
 *      reject a non-allow-listed Origin (no ACAO, handler not reached) — and an allow-listed
 *      origin is treated exactly as before.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const JOB_ID = '99999999-8888-7777-6666-555555555555';
const CANONICAL = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ADDR = '0x1111111111111111111111111111111111111111';

// Rows the public read handlers will find. Everything else is "no row".
const ROWS: Record<string, Record<string, unknown>> = {
  repid_agents: {
    id: AGENT_ID,
    agent_name: 'trinity-fixture',
    display_name: null,
    current_repid: 1299,
    tier: 'ESTABLISHED',
    activity_30d: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    last_updated: '2026-10-01T00:00:00.000Z',
    erc8004_token_id: '5863',
    erc8004_address: CANONICAL,
    mint_tx_hash: '0x' + 'cd'.repeat(32),
    mint_chain_id: 84532,
    minted_at: '2026-05-10T00:00:00.000Z',
    conservator_address: '0x' + '1234567890'.repeat(4),
  },
  repid_zkp_proofs: {
    agent_id: AGENT_ID,
    scheme: 'plonky3_range_check',
    proof_type: 'range',
    proof_bytes: 'AAAA',
    statement: { threshold: 999, repid_score: 1299, tier: 'ESTABLISHED' },
    tier_proven: 'ESTABLISHED',
    eas_attestation_uid: null,
    eas_schema: null,
    is_real: true,
    zk_commitment: '0xcommitment',
    created_at: '2026-10-01T00:00:00.000Z',
  },
  repid_proof_queue: {
    job_id: JOB_ID,
    agent_id: AGENT_ID,
    status: 'pending',
    proof_hash: null,
    proof_bytes: null,
    proof_size_bytes: null,
    created_at: '2026-10-01T00:00:00.000Z',
    completed_at: null,
  },
};

jest.mock('../src/db', () => {
  const makeChain = (table: string) => {
    const row = ROWS[table] ?? null;
    const chain: any = {};
    for (const m of ['select', 'eq', 'or', 'not', 'order', 'limit', 'ilike', 'gte', 'lte', 'in', 'is', 'neq', 'gt', 'lt']) {
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () => ({ data: row, error: null });
    chain.single = async () => ({ data: row, error: null });
    chain.insert = () => chain;
    chain.upsert = async () => ({ data: null, error: null });
    chain.update = () => chain;
    chain.then = (resolve: any) => resolve({ data: row ? [row] : [], count: 0, error: null });
    return chain;
  };
  return { db: { from: (table: string) => makeChain(table), rpc: async () => ({ data: null, error: null }) } };
});

// The faucet reads a balance over RPC. Stub the provider (as tests/faucet-route.test.ts does) so
// no request leaves the process; real utils are kept.
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        getBalance: jest.fn().mockResolvedValue(10n ** 18n),
      })),
      Contract: jest.fn().mockImplementation(() => ({
        balanceOf: jest.fn().mockResolvedValue(1_000_000n),
        decimals: jest.fn().mockResolvedValue(6n),
      })),
    },
  };
});

import request from 'supertest';
import app from '../src/index';
import { OPEN_READ_ROUTES, isOpenReadRequest } from '../src/middleware/open-read-cors';

/** Origins that are NOT on the allow-list: an extension, an arbitrary site, a sandboxed frame. */
const STRANGER_ORIGINS = [
  'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  'https://example.com',
  'null',
];

/** The listed reads. Each must be answered 200 by the REAL handler, so a typo'd path fails here. */
const OPEN_READS: Array<[string, string]> = [
  ['GET /repid/:id (uuid)', `/api/v1/repid/${AGENT_ID}`],
  ['GET /repid/:id (slug)', '/api/v1/repid/fixture'],
  ['GET /repid/:id/proof', `/api/v1/repid/${AGENT_ID}/proof`],
  ['GET /repid/proof/:job_id', `/api/v1/repid/proof/${JOB_ID}`],
  ['GET /passport/:id', `/api/v1/passport/${AGENT_ID}`],
  ['GET /faucet/info', '/api/v1/faucet/info'],
  ['GET /faucet/balance', `/api/v1/faucet/balance?address=${ADDR}`],
];

describe('listed public reads answer ANY origin (the extension / any site can read them)', () => {
  for (const origin of STRANGER_ORIGINS) {
    describe(`Origin: ${origin}`, () => {
      test.each(OPEN_READS)('%s -> 200 with Access-Control-Allow-Origin: *', async (_label, path) => {
        const res = await request(app).get(path).set('Origin', origin);
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        // `*` with credentials would be refused by every browser; the open policy sets none.
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        // Real handler output, not an error page that happens to carry the header.
        expect(res.headers['content-type']).toMatch(/json/);
      });
    });
  }

  test('with no Origin header at all (curl, the extension popup) the reads still work', async () => {
    for (const [, path] of OPEN_READS) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });

  test('/repid/:id carries the mint status end to end, through the real app', async () => {
    const res = await request(app).get(`/api/v1/repid/${AGENT_ID}`).set('Origin', 'chrome-extension://abc');
    expect(res.body).toMatchObject({
      score: 1299,
      tier: 'ESTABLISHED',
      erc8004_token_id: '5863',
      registered_onchain: 'MINTED',
      minted: true,
    });
  });

  test('/passport/:id publishes the canonical registry through the real app', async () => {
    const res = await request(app).get(`/api/v1/passport/${AGENT_ID}`).set('Origin', 'https://example.com');
    expect(res.body.identity_erc8004.contract_address).toBe(CANONICAL);
    expect(res.body.identity_erc8004.contract_address_check).toBe('CANONICAL');
  });

  test('/faucet/balance is a read: it returns a balance and the faucet still dispenses nothing', async () => {
    const info = await request(app).get('/api/v1/faucet/info').set('Origin', 'https://example.com');
    expect(info.body.dispenses).toBe(false);
    const bal = await request(app).get(`/api/v1/faucet/balance?address=${ADDR}`).set('Origin', 'https://example.com');
    expect(bal.body.eth_balance).toBe('1.0');
    expect(bal.body).not.toHaveProperty('tx_hash');
  });
});

describe('preflight on the listed reads', () => {
  test('a stranger origin asking to GET with the version pin is allowed, without credentials', async () => {
    const res = await request(app)
      .options(`/api/v1/repid/${AGENT_ID}`)
      .set('Origin', 'chrome-extension://abc')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-repid-version');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
    expect(res.headers['access-control-allow-headers']).toMatch(/x-repid-version/i);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('a preflight asking for a WRITE on a listed path is not opened', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(app)
        .options(`/api/v1/repid/${AGENT_ID}`)
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', method);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('an open preflight does not grant the keys: x-api-key is not an allowed header', async () => {
    const res = await request(app)
      .options(`/api/v1/repid/${AGENT_ID}`)
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-api-key');
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).not.toContain('x-api-key');
    expect(allowed).not.toContain('authorization');
  });
});

describe('everything else still rejects a non-allow-listed origin', () => {
  /** Mutating, spending, minting, staking, and signing routes — these keep the allow-list. */
  const GUARDED_WRITES: Array<[string, string]> = [
    ['POST /agents/:id/mint', `/api/v1/agents/${AGENT_ID}/mint`],
    ['POST /agents/:id/spend', `/api/v1/agents/${AGENT_ID}/spend`],
    ['POST /agents/register', '/api/v1/agents/register'],
    ['POST /repid/:id/attest', `/api/v1/repid/${AGENT_ID}/attest`],
    ['POST /repid/verify', '/api/v1/repid/verify'],
    ['POST /stake/attempt-trade', '/api/stake/attempt-trade'],
    ['POST /prove-repid', '/api/v1/prove-repid'],
  ];

  for (const origin of STRANGER_ORIGINS) {
    test.each(GUARDED_WRITES)(`%s from ${origin} is refused by the allow-list`, async (_label, path) => {
      const res = await request(app).post(path).set('Origin', origin).send({});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // It died at CORS, not later: the error is the allow-list's own, so the handler never ran.
      expect(res.text).toContain('CORS blocked');
    });
  }

  /** Public reads that are NOT on the list: the list is not a wildcard. */
  const UNLISTED_READS: Array<[string, string]> = [
    ['GET /repid/:id/history', `/api/v1/repid/${AGENT_ID}/history`],
    ['GET /repid/:id/zkp', `/api/v1/repid/${AGENT_ID}/zkp`],
    ['GET /repid/preview/actions', '/api/v1/repid/preview/actions'],
    ['GET /faucet/dispense (does not exist)', '/api/v1/faucet/dispense'],
    ['GET /passport (no id)', '/api/v1/passport/'],
  ];
  test.each(UNLISTED_READS)('%s is not opened', async (_label, path) => {
    const res = await request(app).get(path).set('Origin', 'https://example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  test('a WRITE to a listed path is refused too: the open policy is GET/HEAD only', async () => {
    // POST /repid/:id has no handler; the point is that it never gets the open policy.
    const res = await request(app).post(`/api/v1/repid/${AGENT_ID}`).set('Origin', 'https://example.com').send({});
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
    const del = await request(app).delete(`/api/v1/passport/${AGENT_ID}`).set('Origin', 'https://example.com');
    expect(del.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('an allow-listed origin is treated exactly as before on guarded routes', () => {
  test('preflight for a POST from trustshell.dev echoes that origin and allows credentials', async () => {
    const res = await request(app)
      .options(`/api/v1/agents/${AGENT_ID}/mint`)
      .set('Origin', 'https://trustshell.dev')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://trustshell.dev');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-api-key');
  });
});

describe('the route list itself', () => {
  const probe = (method: string, path: string, headers: Record<string, string> = {}) =>
    isOpenReadRequest({ method, path, headers });

  test('each listed shape matches GET and HEAD, tolerates case and a trailing slash', () => {
    for (const p of [
      '/api/v1/repid/abc', '/api/v1/repid/abc/', '/API/V1/REPID/abc',
      '/api/v1/repid/abc/proof', '/api/v1/repid/proof/job-1',
      '/api/v1/passport/abc', '/api/v1/faucet/info', '/api/v1/faucet/balance',
    ]) {
      expect(probe('GET', p)).toBe(true);
      expect(probe('HEAD', p)).toBe(true);
    }
  });

  test('writes never match, on any listed path', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of ['/api/v1/repid/abc', '/api/v1/passport/abc', '/api/v1/faucet/balance']) {
        expect(probe(m, p)).toBe(false);
      }
    }
  });

  test('a preflight matches only when it asks for a read', () => {
    expect(probe('OPTIONS', '/api/v1/repid/abc', { 'access-control-request-method': 'GET' })).toBe(true);
    expect(probe('OPTIONS', '/api/v1/repid/abc', { 'access-control-request-method': 'post' })).toBe(false);
    expect(probe('OPTIONS', '/api/v1/repid/abc', {})).toBe(false);
  });

  test('near-misses do not match: sub-paths, sibling reads, and look-alike prefixes', () => {
    for (const p of [
      '/api/v1/repid/abc/history', '/api/v1/repid/abc/zkp', '/api/v1/repid/abc/def/ghi',
      '/api/v1/repid/preview/actions', '/api/v1/passport', '/api/v1/passport/a/b',
      '/api/v1/faucet/dispense', '/api/v1/faucet', '/api/v1/faucet/info/extra',
      '/api/v1/agents/abc/mint', '/api/v1/repidx/abc', '/x/api/v1/repid/abc',
    ]) {
      expect(`${p} -> ${probe('GET', p)}`).toBe(`${p} -> false`);
    }
  });

  test('the list is short and explicit (a wildcard added here would fail this)', () => {
    expect(OPEN_READ_ROUTES.length).toBe(5);
  });
});
