/**
 * AGENT_SPEND_SOURCE=stake (Sean's option B, 2026-11-15): the escrow pays the payee out of the
 * owner's stake. The owner's wallet and the agent's key are never touched, and the owner budget is
 * the only cap. Fake escrow send, in-memory ledger with the SQL function's contract.
 */
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { SPEND_CHAIN_ID, agentSpendSource, decideStakeSpend, type SpendChain } from '../src/services/agent-spend';
import { createAgentSpendRouter } from '../src/routes/agent-spend';
import type { OwnerBudgetMode, OwnerBudgetStore, FinishState } from '../src/services/owner-budget';
import type { RefundInitiation } from '../src/services/stake-vault';

const OWNER = new ethers.Wallet('0x' + '33'.repeat(32)).address;
const PAYEE = new ethers.Wallet('0x' + '44'.repeat(32)).address;
const ESCROW = new ethers.Wallet('0x' + '55'.repeat(32)).address;
const AGENT_WALLET = new ethers.Wallet('0x' + '22'.repeat(32)).address;
const BUILDER = '11111111-1111-4111-8111-111111111111';
const AGENTS = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003'];
const usdc = (s: string) => ethers.parseUnits(s, 6);
const tick = () => new Promise((r) => setImmediate(r));

/** Any touch of the wallet path fails the test: on this path the owner's wallet must not be read or signed for. */
const untouchableChain: SpendChain = {
  chainId: async () => { throw new Error('wallet path touched: chainId'); },
  allowance: async () => { throw new Error('wallet path touched: allowance'); },
  balanceOf: async () => { throw new Error('wallet path touched: balanceOf'); },
  ethBalance: async () => { throw new Error('wallet path touched: ethBalance'); },
  gasCost: async () => { throw new Error('wallet path touched: gasCost'); },
  send: async () => { throw new Error('wallet path touched: send'); },
};
void SPEND_CHAIN_ID;

type Outcome = 'sent' | 'refused' | 'unconfirmed' | 'stub' | 'throws';
function fakeEscrow(outcome: Outcome = 'sent') {
  const paid: Array<{ to: string; amount: bigint }> = [];
  let n = 0;
  const payout = async (to: string, amount: bigint): Promise<RefundInitiation> => {
    await tick();
    n += 1;
    const txHash = '0x' + n.toString(16).padStart(64, '0');
    if (outcome === 'throws') throw new Error('boom');
    if (outcome === 'stub') return { initiated: true, stub: true, amount: amount.toString(), to, note: 'not configured' };
    if (outcome === 'refused') return { initiated: false, stub: false, amount: amount.toString(), to, note: 'escrow refund failed: rejected by the node' };
    if (outcome === 'unconfirmed') return { initiated: true, stub: false, unconfirmed: true, amount: amount.toString(), to, txHash, note: 'wait failed' };
    paid.push({ to, amount });
    return { initiated: true, stub: false, amount: amount.toString(), to, txHash };
  };
  return { payout, paid };
}

type Row = { id: string; agent: string; amount: bigint; state: 'reserved' | FinishState; tx: string | null };
function memoryBudget(funded: bigint) {
  const rows: Row[] = [];
  const committed = () => rows.filter((r) => r.state !== 'released').reduce((a, r) => a + r.amount, 0n);
  let n = 0;
  const store: OwnerBudgetStore = {
    async reserve(_b, agent, amount) {
      const c = committed();
      if (c + amount > funded) return { ok: false, id: null, budget: funded, committed: c };
      const id = `r${++n}`;
      rows.push({ id, agent, amount, state: 'reserved', tx: null });
      return { ok: true, id, budget: funded, committed: c + amount };
    },
    async finish(id, state, tx) {
      const r = rows.find((x) => x.id === id && x.state === 'reserved');
      if (!r) throw new Error(`not reserved: ${id}`);
      r.state = state;
      r.tx = tx;
    },
    async status() { return { budget: funded, committed: committed() }; },
    async recordSettled() { throw new Error('shadow recording must not run on the stake path'); },
    async beginWithdrawal() { return { ok: false, debitId: null, funded: 0n, committed: 0n }; },
  };
  return { store, rows, committed };
}

/** NEGATIVE CONTROL: reads the sum, yields, then writes, so concurrent spends race past each other. */
function racyBudget(funded: bigint) {
  let committed = 0n;
  const store: OwnerBudgetStore = {
    async reserve(_b, _a, amount) {
      const c = committed;
      await tick();
      await tick();
      if (c + amount > funded) return { ok: false, id: null, budget: funded, committed: c };
      committed = c + amount;
      return { ok: true, id: `x${c}`, budget: funded, committed };
    },
    async finish() {},
    async status() { return { budget: funded, committed }; },
    async recordSettled() {},
    async beginWithdrawal() { return { ok: false, debitId: null, funded: 0n, committed: 0n }; },
  };
  return { store };
}

function app(opts: {
  store: OwnerBudgetStore;
  payout: (to: string, amount: bigint) => Promise<RefundInitiation>;
  mode?: OwnerBudgetMode;
  source?: 'wallet' | 'stake' | 'invalid';
  escrow?: string | null;
  agentWallet?: string | null | Error;
  builder?: string | null;
}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as any).agent_id = req.path.split('/')[4]; next(); });
  a.use(
    '/api/v1/agents',
    createAgentSpendRouter({
      chain: untouchableChain,
      loadAgent: async () => { throw new Error('agent key loaded on the stake path'); },
      loadOwnerWallet: async () => OWNER,
      enabled: () => true,
      loadOwnerBuilder: async () => (opts.builder === undefined ? BUILDER : opts.builder),
      ownerBudget: opts.store,
      budgetMode: () => opts.mode ?? 'enforce',
      spendSource: () => opts.source ?? 'stake',
      escrow: () => (opts.escrow === undefined ? ESCROW : opts.escrow),
      payout: opts.payout,
      loadAgentWallet: async () => {
        if (opts.agentWallet instanceof Error) throw opts.agentWallet;
        return opts.agentWallet === undefined ? AGENT_WALLET : opts.agentWallet;
      },
    }),
  );
  return a;
}

const spend = (a: express.Express, agent: string, amount: string, opts: { dry_run?: boolean; to?: string } = {}) =>
  request(a).post(`/api/v1/agents/${agent}/spend`).send({ owner_address: OWNER, to_address: opts.to ?? PAYEE, amount_usdc: amount, dry_run: opts.dry_run === true });
const total = (paid: Array<{ amount: bigint }>) => paid.reduce((acc, p) => acc + p.amount, 0n);

describe('the escrow pays from the stake, and all of an owner\'s agents share it', () => {
  it('pays the payee from the escrow, never the owner\'s wallet, and the second agent gets only what is left', async () => {
    const esc = fakeEscrow();
    const ledger = memoryBudget(usdc('10'));
    const a = app({ store: ledger.store, payout: esc.payout });

    const first = await spend(a, AGENTS[0]!, '6');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, spend_source: 'stake', from_escrow: ESCROW, to: PAYEE, amount_usdc: '6.0', owner_budget: { remaining_usdc: '4.0' } });
    expect(first.body.basescan_url).toBe(`https://sepolia.basescan.org/tx/${first.body.tx_hash}`);
    expect(esc.paid).toEqual([{ to: PAYEE, amount: usdc('6') }]);

    const refused = await spend(a, AGENTS[1]!, '6');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'over_owner_budget', owner_budget: { remaining_usdc: '4.0' } });
    expect((await spend(a, AGENTS[1]!, '4')).body).toMatchObject({ ok: true });
    expect(total(esc.paid)).toBe(usdc('10'));
    expect(ledger.rows.map((r) => r.state)).toEqual(['settled', 'settled']);
  });

  it('concurrent spends across three agents never pay out more than the stake', async () => {
    const esc = fakeEscrow();
    const a = app({ store: memoryBudget(usdc('10')).store, payout: esc.payout });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(rs.filter((r) => r.body.ok === true)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(total(esc.paid)).toBe(usdc('10'));
  });

  it('negative control: a store that reads then writes DOES overpay under the same load', async () => {
    const esc = fakeEscrow();
    const a = app({ store: racyBudget(usdc('10')).store, payout: esc.payout });
    await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(total(esc.paid)).toBeGreaterThan(usdc('10'));
  });

  it('a dry run reports the source and the budget, and reserves and sends nothing', async () => {
    const esc = fakeEscrow();
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: esc.payout }), AGENTS[0]!, '3', { dry_run: true });
    expect(r.body).toMatchObject({ ok: true, dry_run: true, would_send: true, spend_source: 'stake', from_escrow: ESCROW, owner_budget: { remaining_usdc: '10.0' } });
    expect(ledger.rows).toHaveLength(0);
    expect(esc.paid).toHaveLength(0);
  });
});

describe('the outcome of the escrow send decides the reservation, and only proof releases it', () => {
  it('proven not sent: released, the budget is whole again', async () => {
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: fakeEscrow('refused').payout }), AGENTS[0]!, '10');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('escrow_did_not_send');
    expect(ledger.rows[0]).toMatchObject({ state: 'released' });
    expect(ledger.committed()).toBe(0n);
  });

  it('a stub (no signer) is not a payment: released', async () => {
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: fakeEscrow('stub').payout }), AGENTS[0]!, '10');
    expect(r.body.code).toBe('escrow_did_not_send');
    expect(ledger.rows[0]).toMatchObject({ state: 'released' });
  });

  it('broadcast but unconfirmed: unknown, it keeps counting, and is NOT reported as paid', async () => {
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: fakeEscrow('unconfirmed').payout }), AGENTS[0]!, '10');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, code: 'spend_unconfirmed' });
    expect(r.body.tx_hash).toMatch(/^0x/);
    expect(ledger.rows[0]).toMatchObject({ state: 'unknown' });
    expect(ledger.committed()).toBe(usdc('10'));
  });

  it('a send that throws: unknown, keeps counting', async () => {
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: fakeEscrow('throws').payout }), AGENTS[0]!, '10');
    expect(r.body.code).toBe('spend_unconfirmed');
    expect(ledger.rows[0]).toMatchObject({ state: 'unknown' });
  });
});

describe('refused before anything is reserved or sent', () => {
  const refusedBefore = async (opts: Partial<Parameters<typeof app>[0]>, code: string, to?: string) => {
    const esc = fakeEscrow();
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ store: ledger.store, payout: esc.payout, ...opts }), AGENTS[0]!, '1', { to });
    expect(r.body).toMatchObject({ ok: false, code });
    expect(ledger.rows).toHaveLength(0);
    expect(esc.paid).toHaveLength(0);
  };

  it.each(['off', 'shadow'] as const)('budget mode %s: the budget is the only cap here, so this path refuses', async (mode) => {
    await refusedBefore({ mode }, 'stake_spend_needs_budget');
  });
  it('no escrow signer configured', () => refusedBefore({ escrow: null }, 'escrow_not_configured'));
  it('the agent\'s wallet cannot be read: not checked', () => refusedBefore({ agentWallet: new Error('db down') }, 'agent_not_checked'));
  it('paying the escrow itself', () => refusedBefore({}, 'pays_escrow', ESCROW));
  it('paying the agent\'s own wallet (it could spend from there outside the budget)', () => refusedBefore({}, 'pays_itself', AGENT_WALLET.toLowerCase()));
  it('the owner has no builder account', () => refusedBefore({ builder: null }, 'no_owner_budget'));
  it('an unrecognised AGENT_SPEND_SOURCE refuses every spend', () => refusedBefore({ source: 'invalid' }, 'spend_source_invalid'));
});

describe('agentSpendSource', () => {
  it('defaults to wallet; stake only when spelled stake; anything else is invalid', () => {
    expect(agentSpendSource(undefined)).toBe('wallet');
    expect(agentSpendSource('')).toBe('wallet');
    expect(agentSpendSource(' Wallet ')).toBe('wallet');
    expect(agentSpendSource('STAKE')).toBe('stake');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(agentSpendSource('stakes')).toBe('invalid');
    expect(agentSpendSource('escrow')).toBe('invalid');
    err.mockRestore();
  });

  it('decideStakeSpend refuses the zero address and a non-address', () => {
    expect(decideStakeSpend(ethers.ZeroAddress, ESCROW, null)).toMatchObject({ ok: false, code: 'bad_payee' });
    expect(decideStakeSpend('nope', ESCROW, null)).toMatchObject({ ok: false, code: 'bad_payee' });
    expect(decideStakeSpend(PAYEE, ESCROW, null)).toEqual({ ok: true });
  });
});
