/**
 * The agent pays from its owner's wallet, up to the USDC cap the owner approved on-chain.
 * The token contract enforces the cap; these tests pin that this server refuses everything the
 * chain would refuse BEFORE signing, plus what the chain would not refuse for us (wrong chain,
 * paying itself, no gas), and that a real send needs AGENT_SPEND_ENABLED. Fake chain, no network.
 */
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { checkSpend, decideSpend, parseUsdc, SPEND_CHAIN_ID, type SpendChain } from '../src/services/agent-spend';
import { createAgentSpendRouter } from '../src/routes/agent-spend';

const AGENT_KEY = '0x' + '22'.repeat(32);
const AGENT = new ethers.Wallet(AGENT_KEY).address;
const OWNER = new ethers.Wallet('0x' + '33'.repeat(32)).address;
const PAYEE = new ethers.Wallet('0x' + '44'.repeat(32)).address;
const usdc = (s: string) => ethers.parseUnits(s, 6);

function fakeChain(over: Partial<{ chainId: bigint; allowance: bigint; balance: bigint; eth: bigint; gas: bigint; revert: boolean }> = {}) {
  const sent: Array<{ owner: string; to: string; amount: bigint }> = [];
  let allowance = over.allowance ?? usdc('10');
  const chain: SpendChain = {
    chainId: async () => over.chainId ?? SPEND_CHAIN_ID,
    allowance: async () => allowance,
    balanceOf: async () => over.balance ?? usdc('100'),
    ethBalance: async () => over.eth ?? ethers.parseEther('0.01'),
    gasCost: async () => {
      if (over.revert) throw new Error('execution reverted: ERC20: transfer amount exceeds allowance');
      return over.gas ?? ethers.parseEther('0.0001');
    },
    send: async (_k, owner, to, amount) => {
      sent.push({ owner, to, amount });
      allowance -= amount;
      return { hash: '0x' + 'ab'.repeat(32), blockNumber: 42, status: 1 };
    },
  };
  return { chain, sent };
}

const ownAgent = async () => ({ key: AGENT_KEY, walletAddress: AGENT });

describe('parseUsdc', () => {
  it.each([['1', usdc('1')], ['1.25', usdc('1.25')], ['0.000001', 1n], [3, usdc('3')]])('%s parses', (input, out) => {
    expect(parseUsdc(input)).toBe(out);
  });
  it.each(['0', '-1', '1.1234567', '1e3', 'abc', '', null, undefined, '0x10'])('%s is refused', (input) => {
    expect(parseUsdc(input)).toBeNull();
  });
});

describe('decideSpend refuses before anything is signed', () => {
  const reads = { chainId: SPEND_CHAIN_ID, allowance: usdc('10'), ownerBalance: usdc('100'), agentEth: 0n };
  const req = { owner: OWNER, to: PAYEE, amount: usdc('2') };

  it('allows a spend inside the cap', () => expect(decideSpend(req, AGENT, reads)).toEqual({ ok: true }));
  it.each([
    ['the wrong chain', { reads: { chainId: 8453n } }, 'wrong_chain'],
    ['no cap at all', { reads: { allowance: 0n } }, 'over_cap'],
    ['more than the cap left', { req: { amount: usdc('10.000001') } }, 'over_cap'],
    ['more than the owner holds', { reads: { ownerBalance: usdc('1') } }, 'owner_balance'],
    ['paying itself', { req: { to: AGENT } }, 'pays_itself'],
    ['owner and agent the same wallet', { req: { owner: AGENT } }, 'owner_is_agent'],
    ['the zero address', { req: { to: ethers.ZeroAddress } }, 'bad_payee'],
    ['a malformed payee', { req: { to: '0x123' } }, 'bad_payee'],
  ] as const)('%s', (_n, over: any, code) => {
    const d = decideSpend({ ...req, ...(over.req ?? {}) }, AGENT, { ...reads, ...(over.reads ?? {}) });
    expect(d).toMatchObject({ ok: false, code });
  });
});

describe('checkSpend', () => {
  const req = { owner: OWNER, to: PAYEE, amount: usdc('2') };
  it('passes with the agent\'s own key, inside the cap, with gas', async () => {
    const { chain } = fakeChain();
    expect(await checkSpend(chain, ownAgent, req)).toMatchObject({ ok: true, agentAddress: AGENT });
  });
  it.each([
    ['no wallet of its own', { load: async () => ({ key: null, walletAddress: AGENT }) }, 'no_wallet'],
    ['a key that is not for the recorded wallet', { load: async () => ({ key: AGENT_KEY, walletAddress: OWNER }) }, 'wallet_mismatch'],
    ['a transfer the chain would revert', { chain: { revert: true } }, 'would_revert'],
    ['no ETH for gas', { chain: { eth: 0n } }, 'no_gas'],
  ] as const)('refuses %s', async (_n, over: any, code) => {
    const { chain, sent } = fakeChain(over.chain);
    expect(await checkSpend(chain, over.load ?? ownAgent, req)).toMatchObject({ ok: false, code });
    expect(sent).toEqual([]);
  });
});

describe('POST /api/v1/agents/:id/spend', () => {
  function app(opts: { enabled: boolean; chain?: Parameters<typeof fakeChain>[0]; boundOwner?: string | null }) {
    const { chain, sent } = fakeChain(opts.chain);
    const a = express();
    a.use(express.json());
    const boundOwner = opts.boundOwner === undefined ? OWNER : opts.boundOwner;
    a.use('/api/v1/agents', createAgentSpendRouter({ chain, loadAgent: ownAgent, loadOwnerWallet: async () => boundOwner, enabled: () => opts.enabled }));
    return { a, sent };
  }
  const body = { owner_address: OWNER, to_address: PAYEE, amount_usdc: '2' };

  it('a dry run works while spending is off, and signs nothing', async () => {
    const { a, sent } = app({ enabled: false });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dry_run: true, would_send: true, agent_wallet: AGENT, reads: { cap_usdc: '10.0', chain_id: 84532 } });
    expect(sent).toEqual([]);
  });

  it('a dry run over the cap says why it would not send', async () => {
    const { a } = app({ enabled: false });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, amount_usdc: '11', dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, would_send: false, code: 'over_cap', agent_wallet: AGENT });
  });

  // An agent spends only from the wallet bound as its owner. Before 2026-10-07 any wallet that had
  // approved it would do, so the binding — the record of whose agent this is — decided nothing.
  it('an agent nobody has bound cannot spend, and a dry run says to bind it', async () => {
    const { a, sent } = app({ enabled: true, boundOwner: null });
    const dry = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ ok: false, would_send: false, code: 'not_bound' });
    const real = await request(a).post('/api/v1/agents/agent-1/spend').send(body);
    expect(real.status).toBe(403);
    expect(real.body.code).toBe('not_bound');
    expect(sent).toEqual([]);
  });

  it("a wallet that approved the agent but is not its bound owner cannot be spent from", async () => {
    const someoneElse = '0x9999999999999999999999999999999999999999';
    const { a, sent } = app({ enabled: true, boundOwner: someoneElse });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send(body);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'not_owner', bound_owner: someoneElse });
    expect(sent).toEqual([]);
  });

  it('the owner check is case-insensitive on the address', async () => {
    const { a } = app({ enabled: false, boundOwner: OWNER.toUpperCase().replace('0X', '0x') });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, dry_run: true });
    expect(res.body).toMatchObject({ ok: true, would_send: true });
  });

  it('a real send is refused while AGENT_SPEND_ENABLED is off', async () => {
    const { a, sent } = app({ enabled: false });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('spending_off');
    expect(sent).toEqual([]);
  });

  it('when on, sends transferFrom from the owner and returns the Basescan receipt', async () => {
    const { a, sent } = app({ enabled: true });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send(body);
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ owner: OWNER, to: PAYEE, amount: usdc('2') }]);
    expect(res.body).toMatchObject({
      ok: true,
      tx_hash: '0x' + 'ab'.repeat(32),
      basescan_url: 'https://sepolia.basescan.org/tx/0x' + 'ab'.repeat(32),
      amount_usdc: '2.0',
      cap_before_usdc: '10.0',
      cap_after_usdc: '8.0',
      agent_wallet: AGENT,
    });
  });

  it('when on, over the cap is a 409 and nothing is sent', async () => {
    const { a, sent } = app({ enabled: true });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, amount_usdc: '10.5' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('over_cap');
    expect(sent).toEqual([]);
  });

  it.each([
    ['a bad amount', { amount_usdc: '1.1234567' }],
    ['a missing owner', { owner_address: undefined }],
  ])('%s is a 400', async (_n, over) => {
    const { a, sent } = app({ enabled: true });
    const res = await request(a).post('/api/v1/agents/agent-1/spend').send({ ...body, ...over });
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});
