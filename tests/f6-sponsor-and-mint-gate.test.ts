/**
 * [F-6, 2026-10-07] The two gaps F1 left open.
 *
 * 1. POST /staking/sponsor wrote a sponsorship row for any sponsor named in the body, with any
 *    key. F2 stopped the payment gate counting those rows; this stops the write itself, with the
 *    same rule as /staking/deposit: the operator's key, or the signature of the wallet that
 *    answers for the SPONSOR over these exact settings.
 * 2. POST /agents/:id/mint ran for any valid key. The minter pays the gas, and the auth middleware
 *    binds an agent key only to a UUID in the path, so a key for one agent could mint another by
 *    name. Now: the operator's key, or the agent's own key. A dry run spends nothing and stays open.
 */
import express from 'express';
import request from 'supertest';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, paramsHash, __resetOwnerAuthNonces } from '../src/services/owner-authorization';

const SPONSOR = 'aaaaaaaa-1111-2222-3333-444444444444';
const SPONSORED = 'bbbbbbbb-1111-2222-3333-444444444444';

const mockInserts: Array<{ table: string; row: unknown }> = [];

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, is: () => c, order: () => c, limit: () => c, in: () => c, gte: () => c,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: { id: 1, table }, error: null }),
      insert: (row: unknown) => { mockInserts.push({ table, row }); return c; },
      then: (r: any) => r({ data: [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) } };
});

type Root = { ok: true; root: Record<string, unknown> } | { ok: false; code: string; message: string };
const mockRoot: { value: Root } = { value: { ok: false, code: 'no_root', message: 'nobody' } };
jest.mock('../src/services/accountable-root', () => ({
  ...jest.requireActual('../src/services/accountable-root'),
  resolveAccountableRoot: jest.fn(async () => mockRoot.value),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mvpRouter = require('../src/routes/mvp-api').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAgentsOnchainRouter } = require('../src/routes/agents-onchain');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Erc8004Minter } = require('../src/services/erc8004-minter');

beforeEach(() => {
  mockInserts.length = 0;
  __resetOwnerAuthNonces();
  process.env.REPID_API_KEYS = 'operator-key:pro';
});

describe('POST /staking/sponsor needs someone who answers for the sponsor', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1', mvpRouter);
    return a;
  };
  const body = { sponsor_agent: SPONSOR, sponsored_agent: SPONSORED, collateral_usdc: 30 };
  const owned = (w: Wallet): Root => ({ ok: true, root: { kind: 'owner', agentId: SPONSOR, subjectId: SPONSOR, wallet: w.address, assurance: 'wallet-proven', via: 'own-binding', grantPath: [] } });

  async function approve(w: Wallet, overrides: Record<string, string> = {}) {
    const nonce = hexlify(randomBytes(32));
    const expires_at = Math.floor(Date.now() / 1000) + 300;
    const params = { sponsor_agent: SPONSOR, sponsored_agent: SPONSORED, collateral_usdc: '30', ...overrides };
    const signature = await w.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, {
      subject: SPONSOR, action: 'stake.sponsor', params: paramsHash(params), nonce, expiresAt: expires_at,
    });
    return { signature, nonce, expires_at };
  }
  const sponsorRows = () => mockInserts.filter((i) => i.table === 'sponsorship_records');

  it('a key for a sponsor nobody answers for: 403, no row', async () => {
    mockRoot.value = { ok: false, code: 'no_root', message: 'nobody' };
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'some-agent-key').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_accountable_root');
    expect(sponsorRows()).toHaveLength(0);
  });

  it('a failed owner lookup is NOT CHECKED (503), never a write', async () => {
    mockRoot.value = { ok: false, code: 'not_checked', message: 'db down' };
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'some-agent-key').send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('root_not_checked');
    expect(sponsorRows()).toHaveLength(0);
  });

  it("an owned sponsor's key alone, without the owner's signature: 403, no row", async () => {
    mockRoot.value = owned(Wallet.createRandom());
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'some-agent-key').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_authorization_required');
    expect(sponsorRows()).toHaveLength(0);
  });

  it('a signature over a different amount does not authorize this one', async () => {
    const owner = Wallet.createRandom();
    mockRoot.value = owned(owner);
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'some-agent-key')
      .send({ ...body, owner_authorization: await approve(owner, { collateral_usdc: '3' }) });
    expect(res.status).toBe(403);
    expect(sponsorRows()).toHaveLength(0);
  });

  it("with the owner's signature over this exact sponsorship, the row is written", async () => {
    const owner = Wallet.createRandom();
    mockRoot.value = owned(owner);
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'some-agent-key')
      .send({ ...body, owner_authorization: await approve(owner) });
    expect(res.status).toBe(200);
    expect(sponsorRows()).toHaveLength(1);
  });

  it('the operator key still works for house operations', async () => {
    mockRoot.value = { ok: false, code: 'no_root', message: 'nobody' };
    const res = await request(app()).post('/api/v1/staking/sponsor').set('x-api-key', 'operator-key').send(body);
    expect(res.status).toBe(200);
    expect(sponsorRows()).toHaveLength(1);
  });
});

describe('POST /agents/:id/mint: only the operator, or the agent itself', () => {
  const AGENT = 'cccccccc-1111-2222-3333-444444444444';
  const OTHER = 'dddddddd-1111-2222-3333-444444444444';
  let mintCalls = 0;
  let lookup: { data: unknown; error: { message: string } | null } = { data: [{ id: AGENT }], error: null };
  const supabase = {
    from: () => {
      const c: any = { select: () => c, eq: () => Promise.resolve(lookup) };
      return c;
    },
  };
  const proto = Erc8004Minter.prototype as any;
  let originalMint: unknown;
  beforeAll(() => {
    originalMint = proto.mint;
    proto.mint = async () => { mintCalls += 1; return { ok: true }; };
    process.env.ERC8004_MINTER_PRIVATE_KEY = '0x' + '11'.repeat(32);
  });
  afterAll(() => {
    proto.mint = originalMint;
    delete process.env.ERC8004_MINTER_PRIVATE_KEY;
  });
  beforeEach(() => {
    mintCalls = 0;
    lookup = { data: [{ id: AGENT }], error: null };
  });

  /** `callerAgent` stands in for what authMiddleware attaches for a DB-issued agent key. */
  const app = (callerAgent?: string) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { if (callerAgent) (req as any).agent_id = callerAgent; next(); });
    a.use('/api/v1/agents', createAgentsOnchainRouter(supabase as any));
    return a;
  };

  it('a key with no agent behind it (not the operator): 403, nothing minted', async () => {
    const res = await request(app()).post('/api/v1/agents/trinity-sophia/mint').set('x-api-key', 'some-tier-key').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mint_not_yours');
    expect(mintCalls).toBe(0);
  });

  it("another agent's key, naming this agent BY NAME: 403, nothing minted", async () => {
    const res = await request(app(OTHER)).post('/api/v1/agents/trinity-sophia/mint').set('x-api-key', 'other-agent-key').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mint_not_yours');
    expect(mintCalls).toBe(0);
  });

  it('a name that matches two agents is refused, not guessed', async () => {
    lookup = { data: [{ id: AGENT }, { id: OTHER }], error: null };
    const res = await request(app(AGENT)).post('/api/v1/agents/trinity-sophia/mint').set('x-api-key', 'own-key').send({});
    expect(res.status).toBe(403);
    expect(mintCalls).toBe(0);
  });

  it('a failed lookup is NOT CHECKED (503), never a mint', async () => {
    lookup = { data: null, error: { message: 'db down' } };
    const res = await request(app(AGENT)).post('/api/v1/agents/trinity-sophia/mint').set('x-api-key', 'own-key').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_checked');
    expect(mintCalls).toBe(0);
  });

  it("the agent's own key mints its own identity", async () => {
    const res = await request(app(AGENT)).post('/api/v1/agents/trinity-sophia/mint').set('x-api-key', 'own-key').send({});
    expect(res.status).toBe(200);
    expect(mintCalls).toBe(1);
  });

  it('the operator key mints for any agent', async () => {
    const res = await request(app()).post(`/api/v1/agents/${OTHER}/mint`).set('x-api-key', 'operator-key').send({});
    expect(res.status).toBe(200);
    expect(mintCalls).toBe(1);
  });
});
