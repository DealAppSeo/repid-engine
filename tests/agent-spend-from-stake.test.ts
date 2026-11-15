/**
 * AGENT_SPEND_SOURCE=stake (Sean's option B, 2026-11-15): the escrow pays the payee out of the
 * owner's stake. The owner's wallet and the agent's key are never touched. Two caps, both checked in
 * one reservation: the limit the OWNER SIGNED for this agent (the binding grants no spending
 * authority, Strix on #1551), and the owner's shared budget. Fake escrow send; in-memory ledger with
 * reserve_agent_stake_spend's contract, run without yielding.
 */
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { agentSpendSource, decideStakeSpend, type SpendChain } from '../src/services/agent-spend';
import { createAgentSpendRouter } from '../src/routes/agent-spend';
import type { AgentLimitStore, OwnerBudgetMode, OwnerBudgetStore, FinishState } from '../src/services/owner-budget';
import type { RefundInitiation } from '../src/services/stake-vault';
import { OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, paramsHash, __resetOwnerAuthNonces } from '../src/services/owner-authorization';

const OWNER_KEY = '0x' + '33'.repeat(32);
const OWNER = new ethers.Wallet(OWNER_KEY).address;
const STRANGER_KEY = '0x' + '66'.repeat(32);
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

type Row = { id: string; agent: string; amount: bigint; state: 'reserved' | FinishState; tx: string | null; at: number };
type Limit = { agent: string; amount: bigint; at: number; by: string };

/** The ledger plus the agent limits, with reserve_agent_stake_spend's contract (no yield inside). */
function memoryLedger(funded: bigint, limits: Record<string, string> = {}) {
  const rows: Row[] = [];
  let clock = 1;
  const lims: Limit[] = Object.entries(limits).map(([agent, s]) => ({ agent, amount: usdc(s), at: clock++, by: OWNER.toLowerCase() }));
  const committed = () => rows.filter((r) => r.state !== 'released').reduce((a, r) => a + r.amount, 0n);
  const latest = (agent: string) => lims.filter((l) => l.agent === agent).sort((a, b) => b.at - a.at)[0];
  const agentCommitted = (agent: string, since: number) =>
    rows.filter((r) => r.agent === agent && r.state !== 'released' && r.at >= since).reduce((a, r) => a + r.amount, 0n);
  let n = 0;
  const budget: OwnerBudgetStore = {
    async reserve() { throw new Error('the stake path must reserve through reserve_agent_stake_spend'); },
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
  const agentLimits: AgentLimitStore = {
    async reserve(_b, agent, amount) {
      const c = committed();
      const l = latest(agent);
      if (!l) return { ok: false, id: null, reason: 'no_spend_limit', budget: funded, committed: c, agentLimit: null, agentCommitted: 0n };
      const ac = agentCommitted(agent, l.at);
      if (ac + amount > l.amount) return { ok: false, id: null, reason: 'over_agent_limit', budget: funded, committed: c, agentLimit: l.amount, agentCommitted: ac };
      if (c + amount > funded) return { ok: false, id: null, reason: 'over_owner_budget', budget: funded, committed: c, agentLimit: l.amount, agentCommitted: ac };
      const id = `r${++n}`;
      rows.push({ id, agent, amount, state: 'reserved', tx: null, at: clock++ });
      return { ok: true, id, reason: null, budget: funded, committed: c + amount, agentLimit: l.amount, agentCommitted: ac + amount };
    },
    async status(_b, agent) {
      const l = latest(agent);
      return l ? { agentLimit: l.amount, agentCommitted: agentCommitted(agent, l.at) } : { agentLimit: null, agentCommitted: 0n };
    },
    async set(_b, agent, amount, by) { lims.push({ agent, amount, at: clock++, by }); },
  };
  return { budget, agentLimits, rows, lims, committed };
}

const ALL_LIMITS = { [AGENTS[0]!]: '100', [AGENTS[1]!]: '100', [AGENTS[2]!]: '100' };

/** NEGATIVE CONTROL: reads the sums, yields, then writes, so concurrent spends race past each other. */
function racyLedger(funded: bigint) {
  const base = memoryLedger(funded, ALL_LIMITS);
  let committed = 0n;
  const agentLimits: AgentLimitStore = {
    async reserve(_b, _a, amount) {
      const c = committed;
      await tick();
      await tick();
      if (c + amount > funded) return { ok: false, id: null, reason: 'over_owner_budget', budget: funded, committed: c, agentLimit: usdc('100'), agentCommitted: 0n };
      committed = c + amount;
      return { ok: true, id: `x${c}`, reason: null, budget: funded, committed, agentLimit: usdc('100'), agentCommitted: 0n };
    },
    status: base.agentLimits.status,
    set: base.agentLimits.set,
  };
  return { budget: { ...base.budget, async finish() {} } as OwnerBudgetStore, agentLimits };
}

function app(opts: {
  ledger: { budget: OwnerBudgetStore; agentLimits: AgentLimitStore };
  payout?: (to: string, amount: bigint) => Promise<RefundInitiation>;
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
      ownerBudget: opts.ledger.budget,
      agentLimits: opts.ledger.agentLimits,
      budgetMode: () => opts.mode ?? 'enforce',
      spendSource: () => opts.source ?? 'stake',
      escrow: () => (opts.escrow === undefined ? ESCROW : opts.escrow),
      payout: opts.payout ?? fakeEscrow().payout,
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
    const ledger = memoryLedger(usdc('10'), ALL_LIMITS);
    const a = app({ ledger, payout: esc.payout });

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
    const a = app({ ledger: memoryLedger(usdc('10'), ALL_LIMITS), payout: esc.payout });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(rs.filter((r) => r.body.ok === true)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(total(esc.paid)).toBe(usdc('10'));
  });

  it('negative control: a store that reads then writes DOES overpay under the same load', async () => {
    const esc = fakeEscrow();
    const a = app({ ledger: racyLedger(usdc('10')), payout: esc.payout });
    await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(total(esc.paid)).toBeGreaterThan(usdc('10'));
  });

  it('a dry run reports the source, the budget and the agent limit, and reserves and sends nothing', async () => {
    const esc = fakeEscrow();
    const ledger = memoryLedger(usdc('10'), { [AGENTS[0]!]: '5' });
    const r = await spend(app({ ledger, payout: esc.payout }), AGENTS[0]!, '3', { dry_run: true });
    expect(r.body).toMatchObject({
      ok: true, dry_run: true, would_send: true, spend_source: 'stake', from_escrow: ESCROW,
      owner_budget: { remaining_usdc: '10.0' }, agent_limit: { limit_usdc: '5.0', remaining_usdc: '5.0' },
    });
    expect(ledger.rows).toHaveLength(0);
    expect(esc.paid).toHaveLength(0);
  });
});

describe('the owner\'s signed limit: the agent key alone cannot move the stake', () => {
  it('no limit signed: refused, nothing reserved or sent (dry run says so too)', async () => {
    const esc = fakeEscrow();
    const ledger = memoryLedger(usdc('10'));
    const a = app({ ledger, payout: esc.payout });
    const dry = await spend(a, AGENTS[0]!, '1', { dry_run: true });
    expect(dry.body).toMatchObject({ ok: false, code: 'no_spend_limit', agent_limit: { limit_usdc: null } });
    const real = await spend(a, AGENTS[0]!, '1');
    expect(real.status).toBe(403);
    expect(real.body.code).toBe('no_spend_limit');
    expect(ledger.rows).toHaveLength(0);
    expect(esc.paid).toHaveLength(0);
  });

  it('one agent stops at its own limit while the owner budget still has room', async () => {
    const esc = fakeEscrow();
    const ledger = memoryLedger(usdc('10'), { [AGENTS[0]!]: '3', [AGENTS[1]!]: '5' });
    const a = app({ ledger, payout: esc.payout });
    expect((await spend(a, AGENTS[0]!, '2')).body).toMatchObject({ ok: true, agent_limit: { limit_usdc: '3.0', remaining_usdc: '1.0' } });
    const over = await spend(a, AGENTS[0]!, '2');
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'over_agent_limit', agent_limit: { remaining_usdc: '1.0' }, owner_budget: { remaining_usdc: '8.0' } });
    expect((await spend(a, AGENTS[1]!, '5')).body).toMatchObject({ ok: true });
    expect(total(esc.paid)).toBe(usdc('7'));
  });

  it('a new limit replaces the old one and counts from when it was set; 0 stops the agent', async () => {
    const esc = fakeEscrow();
    const ledger = memoryLedger(usdc('10'), { [AGENTS[0]!]: '2' });
    const a = app({ ledger, payout: esc.payout });
    expect((await spend(a, AGENTS[0]!, '2')).body.ok).toBe(true);
    await ledger.agentLimits.set(BUILDER, AGENTS[0]!, usdc('3'), 'owner');
    expect((await spend(a, AGENTS[0]!, '3')).body.ok).toBe(true);
    await ledger.agentLimits.set(BUILDER, AGENTS[0]!, 0n, 'stop');
    expect((await spend(a, AGENTS[0]!, '0.000001')).body.code).toBe('over_agent_limit');
  });
});

describe('the outcome of the escrow send decides the reservation, and only proof releases it', () => {
  const one = () => memoryLedger(usdc('10'), ALL_LIMITS);

  it('proven not sent: released, the budget is whole again', async () => {
    const ledger = one();
    const r = await spend(app({ ledger, payout: fakeEscrow('refused').payout }), AGENTS[0]!, '10');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('escrow_did_not_send');
    expect(ledger.rows[0]).toMatchObject({ state: 'released' });
    expect(ledger.committed()).toBe(0n);
  });

  it('a stub (no signer) is not a payment: released', async () => {
    const ledger = one();
    const r = await spend(app({ ledger, payout: fakeEscrow('stub').payout }), AGENTS[0]!, '10');
    expect(r.body.code).toBe('escrow_did_not_send');
    expect(ledger.rows[0]).toMatchObject({ state: 'released' });
  });

  it('broadcast but unconfirmed: unknown, it keeps counting, and is NOT reported as paid', async () => {
    const ledger = one();
    const r = await spend(app({ ledger, payout: fakeEscrow('unconfirmed').payout }), AGENTS[0]!, '10');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, code: 'spend_unconfirmed' });
    expect(r.body.tx_hash).toMatch(/^0x/);
    expect(ledger.rows[0]).toMatchObject({ state: 'unknown' });
    expect(ledger.committed()).toBe(usdc('10'));
  });

  it('a send that throws: unknown, keeps counting', async () => {
    const ledger = one();
    const r = await spend(app({ ledger, payout: fakeEscrow('throws').payout }), AGENTS[0]!, '10');
    expect(r.body.code).toBe('spend_unconfirmed');
    expect(ledger.rows[0]).toMatchObject({ state: 'unknown' });
  });
});

describe('refused before anything is reserved or sent', () => {
  const refusedBefore = async (opts: Partial<Parameters<typeof app>[0]>, code: string, to?: string) => {
    const esc = fakeEscrow();
    const ledger = memoryLedger(usdc('10'), ALL_LIMITS);
    const r = await spend(app({ ledger, payout: esc.payout, ...opts }), AGENTS[0]!, '1', { to });
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

describe('POST /:id/spend-limit: raising it takes the owner\'s own signature', () => {
  beforeEach(() => __resetOwnerAuthNonces());

  const approval = async (agentId: string, limitMicro: bigint, key = OWNER_KEY, nonce = ethers.hexlify(ethers.randomBytes(32))) => {
    const expires_at = Math.floor(Date.now() / 1000) + 300;
    const value = { subject: agentId, action: 'spend.limit', params: paramsHash({ agent_id: agentId, limit_micro_usdc: limitMicro.toString() }), nonce, expiresAt: expires_at };
    return { signature: await new ethers.Wallet(key).signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, value), nonce, expires_at };
  };
  const setLimit = (a: express.Express, agent: string, body: Record<string, unknown>) =>
    request(a).post(`/api/v1/agents/${agent}/spend-limit`).send(body);

  it('the owner\'s signature over this agent and this amount sets the limit', async () => {
    const ledger = memoryLedger(usdc('10'));
    const a = app({ ledger });
    const r = await setLimit(a, AGENTS[0]!, { limit_usdc: '2.5', owner_authorization: await approval(AGENTS[0]!, usdc('2.5')) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, limit_usdc: '2.5', set_by: 'owner signature' });
    expect(ledger.lims).toEqual([expect.objectContaining({ agent: AGENTS[0], amount: usdc('2.5'), by: OWNER.toLowerCase() })]);
  });

  it('no signature: refused, nothing recorded', async () => {
    const ledger = memoryLedger(usdc('10'));
    const r = await setLimit(app({ ledger }), AGENTS[0]!, { limit_usdc: '2.5' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('owner_authorization_required');
    expect(ledger.lims).toHaveLength(0);
  });

  it('signed by another wallet, for a different amount, or for a different agent: refused', async () => {
    const ledger = memoryLedger(usdc('10'));
    const a = app({ ledger });
    const stranger = await setLimit(a, AGENTS[0]!, { limit_usdc: '2.5', owner_authorization: await approval(AGENTS[0]!, usdc('2.5'), STRANGER_KEY) });
    const bigger = await setLimit(a, AGENTS[0]!, { limit_usdc: '9', owner_authorization: await approval(AGENTS[0]!, usdc('2.5')) });
    const otherAgent = await setLimit(a, AGENTS[0]!, { limit_usdc: '2.5', owner_authorization: await approval(AGENTS[1]!, usdc('2.5')) });
    for (const r of [stranger, bigger, otherAgent]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('bad_signature');
    }
    expect(ledger.lims).toHaveLength(0);
  });

  it('a used approval cannot be replayed', async () => {
    const ledger = memoryLedger(usdc('10'));
    const a = app({ ledger });
    const auth = await approval(AGENTS[0]!, usdc('2.5'));
    expect((await setLimit(a, AGENTS[0]!, { limit_usdc: '2.5', owner_authorization: auth })).status).toBe(201);
    const again = await setLimit(a, AGENTS[0]!, { limit_usdc: '2.5', owner_authorization: auth });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('replayed');
    expect(ledger.lims).toHaveLength(1);
  });

  it('0 stops the agent with no signature', async () => {
    const ledger = memoryLedger(usdc('10'), { [AGENTS[0]!]: '5' });
    const r = await setLimit(app({ ledger }), AGENTS[0]!, { limit_usdc: '0' });
    expect(r.status).toBe(201);
    expect(r.body.set_by).toMatch(/^stop/);
    expect(ledger.lims.at(-1)).toMatchObject({ amount: 0n, by: 'stop' });
  });

  it('only this agent\'s own key may call it', async () => {
    const ledger = memoryLedger(usdc('10'));
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as any).agent_id = AGENTS[1]; next(); });
    a.use('/api/v1/agents', createAgentSpendRouter({ agentLimits: ledger.agentLimits, loadOwnerWallet: async () => OWNER, loadOwnerBuilder: async () => BUILDER }));
    const r = await setLimit(a, AGENTS[0]!, { limit_usdc: '0' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_this_agent');
    expect(ledger.lims).toHaveLength(0);
  });
});

describe('reserve_agent_stake_spend (the SQL the limit depends on)', () => {
  const sql = readFileSync(join(__dirname, '../supabase/migrations/20261115120000_agent_spend_limits.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.reserve_agent_stake_spend'));

  it('takes the same per-owner lock as reserve_owner_spend, before any read', () => {
    const lock = fn.indexOf("pg_advisory_xact_lock(hashtextextended('owner_spend:' || p_builder::text, 0))");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(fn.indexOf('owner_funded_stake('));
    expect(lock).toBeLessThan(fn.indexOf('from public.agent_spend_limits'));
  });

  it('refuses with no limit, then checks the agent limit and the owner budget, all before the insert', () => {
    const insert = fn.indexOf('insert into public.owner_spend_ledger');
    for (const reason of ["'no_spend_limit'", "'over_agent_limit'", "'over_owner_budget'"]) {
      expect(fn.indexOf(reason)).toBeGreaterThan(0);
      expect(fn.indexOf(reason)).toBeLessThan(insert);
    }
    expect(fn).toMatch(/and created_at >= v_since/);
  });

  it('is service-role only', () => {
    expect(sql).toMatch(/revoke all on public\.agent_spend_limits from anon, authenticated/);
    expect(sql).toMatch(/revoke all on function public\.reserve_agent_stake_spend\(uuid, uuid, bigint\) from public, anon, authenticated/);
  });
});

describe('agentSpendSource and decideStakeSpend', () => {
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

  it('a bad EIP-55 checksum on the escrow or agent wallet does not skip the guard (Grok r1b)', () => {
    // Flip the case of one letter in a valid checksum: the same 20 bytes, rejected by ethers.isAddress.
    const badCase = (a: string) => { const i = [...a].findIndex((c, k) => k > 1 && /[a-f]/i.test(c)); return a.slice(0, i) + (a[i] === a[i]!.toUpperCase() ? a[i]!.toLowerCase() : a[i]!.toUpperCase()) + a.slice(i + 1); };
    expect(ethers.isAddress(badCase(ESCROW))).toBe(false);
    expect(decideStakeSpend(ESCROW.toLowerCase(), badCase(ESCROW), null)).toMatchObject({ ok: false, code: 'pays_escrow' });
    expect(decideStakeSpend(AGENT_WALLET.toLowerCase(), ESCROW, badCase(AGENT_WALLET))).toMatchObject({ ok: false, code: 'pays_itself' });
  });
});
