/**
 * [F2] Unbacked stake no longer raises what an agent may spend, and placing it needs someone who
 * answers for the agent.
 *
 * Measured in production on 2026-10-07: the payment gate summed 4 prediction-market wagers
 * (agent_stakes) and 8 sponsorship rows (sponsorship_records) as stake — 12 active rows — while 0
 * deposits were non-simulated with a transaction behind them. Any agent key could write itself
 * such a row through POST /staking/deposit and raise its own ceiling. Both halves change together.
 */
import express from 'express';
import request from 'supertest';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, paramsHash, __resetOwnerAuthNonces } from '../src/services/owner-authorization';

const AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';

const mockRows: Record<string, unknown> = {};
const mockInserts: Array<{ table: string; row: unknown }> = [];

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, is: () => c, order: () => c, limit: () => c, in: () => c, gte: () => c,
      maybeSingle: () => Promise.resolve({ data: (mockRows[table] as any) ?? null, error: null }),
      single: () => Promise.resolve({ data: { id: 1, table }, error: null }),
      insert: (row: unknown) => { mockInserts.push({ table, row }); return c; },
      then: (r: any) => r({ data: Array.isArray(mockRows[table]) ? mockRows[table] : [], error: null }),
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
const { loadAuthorityContext, checkTransactionAuthority } = require('../src/services/x402-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mvpRouter = require('../src/routes/mvp-api').default;

beforeEach(() => {
  for (const k of Object.keys(mockRows)) delete mockRows[k];
  mockInserts.length = 0;
  __resetOwnerAuthNonces();
  process.env.REPID_API_KEYS = 'operator-key:pro';
});

describe('the payment gate does not count stake that backs nothing', () => {
  it('wagers and sponsorship rows add nothing to stake_available, and are reported as ignored', async () => {
    mockRows['repid_agents'] = { tier: 'ESTABLISHED', current_repid: 1500, conservator_address: null };
    mockRows['agent_stakes'] = [{ stake_amount: 100_000_000 }]; // 100 USDC in micro-USDC
    mockRows['sponsorship_records'] = [{ collateral_usdc: 300 }];
    const ctx = await loadAuthorityContext('trinity-test');
    expect(ctx.stake_available).toBe(0);
    expect(ctx.unbacked_stake_ignored_usdc).toBe(400);
  });

  it('so an ESTABLISHED agent with only unbacked rows is refused for insufficient stake (before: authorized)', async () => {
    mockRows['repid_agents'] = { tier: 'ESTABLISHED', current_repid: 1500, conservator_address: null };
    mockRows['agent_stakes'] = [{ stake_amount: 100_000_000 }];
    const d = await checkTransactionAuthority({ agent: 'trinity-test', transaction_type: 'escrow', amount: 5 });
    expect(d).toMatchObject({ authorized: false, denial_reason: 'insufficient_stake', stake_available: 0 });
  });

  it('tiers that need no stake are unchanged', async () => {
    mockRows['repid_agents'] = { tier: 'AUTONOMOUS', current_repid: 6000, conservator_address: null };
    const ctx = await loadAuthorityContext('trinity-test');
    expect(ctx.stake_available).toBe(6000);
  });
});

describe('POST /staking/deposit needs someone who answers for the agent', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1', mvpRouter);
    return a;
  };
  const body = { agent: AGENT, amount: 10, target_model: 'm', dimension: 'general' };

  async function approve(w: Wallet) {
    const nonce = hexlify(randomBytes(32));
    const expires_at = Math.floor(Date.now() / 1000) + 300;
    const params = { agent: AGENT, amount: '10', target_model: 'm', dimension: 'general' };
    const signature = await w.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, {
      subject: AGENT, action: 'stake.deposit', params: paramsHash(params), nonce, expiresAt: expires_at,
    });
    return { signature, nonce, expires_at };
  }

  it('an agent key for an agent nobody answers for: 403, no stake row', async () => {
    mockRoot.value = { ok: false, code: 'no_root', message: 'nobody' };
    const res = await request(app()).post('/api/v1/staking/deposit').set('x-api-key', 'some-agent-key').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_accountable_root');
    expect(mockInserts.filter((i) => i.table === 'agent_stakes')).toHaveLength(0);
  });

  it("an owned agent's key alone, without the owner's signature: 403, no stake row", async () => {
    const owner = Wallet.createRandom();
    mockRoot.value = { ok: true, root: { kind: 'owner', agentId: AGENT, subjectId: AGENT, wallet: owner.address, assurance: 'wallet-proven', via: 'own-binding', grantPath: [] } };
    const res = await request(app()).post('/api/v1/staking/deposit').set('x-api-key', 'some-agent-key').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_authorization_required');
    expect(mockInserts.filter((i) => i.table === 'agent_stakes')).toHaveLength(0);
  });

  it("with the owner's signature over this exact deposit, the row is written", async () => {
    const owner = Wallet.createRandom();
    mockRoot.value = { ok: true, root: { kind: 'owner', agentId: AGENT, subjectId: AGENT, wallet: owner.address, assurance: 'wallet-proven', via: 'own-binding', grantPath: [] } };
    const res = await request(app()).post('/api/v1/staking/deposit').set('x-api-key', 'some-agent-key').send({ ...body, owner_authorization: await approve(owner) });
    expect(res.status).toBe(200);
    expect(mockInserts.filter((i) => i.table === 'agent_stakes')).toHaveLength(1);
  });

  it('the operator key still works for house operations', async () => {
    mockRoot.value = { ok: false, code: 'no_root', message: 'nobody' };
    const res = await request(app()).post('/api/v1/staking/deposit').set('x-api-key', 'operator-key').send(body);
    expect(res.status).toBe(200);
    expect(mockInserts.filter((i) => i.table === 'agent_stakes')).toHaveLength(1);
  });
});
