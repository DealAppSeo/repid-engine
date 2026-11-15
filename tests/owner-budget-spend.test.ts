/**
 * Every agent bound to one owner spends against ONE budget, the owner's funded stake.
 * Fake chain, in-memory ledger: these tests pin what the spend route does with the budget
 * (reserve before signing, settle / release / unknown, fail closed, shadow never refuses).
 * The concurrency guarantee itself lives in Postgres (reserve_owner_spend); the last block pins
 * the parts of that SQL the guarantee depends on, and the testnet run exercises it for real.
 */
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { SPEND_CHAIN_ID, revertedReceipt, type SpendChain } from '../src/services/agent-spend';
import { createAgentSpendRouter } from '../src/routes/agent-spend';
import { ownerBudgetMode, type OwnerBudgetMode, type OwnerBudgetStore, type FinishState } from '../src/services/owner-budget';

const AGENT_KEY = '0x' + '22'.repeat(32);
const AGENT = new ethers.Wallet(AGENT_KEY).address;
const OWNER = new ethers.Wallet('0x' + '33'.repeat(32)).address;
const PAYEE = new ethers.Wallet('0x' + '44'.repeat(32)).address;
const BUILDER = '11111111-1111-4111-8111-111111111111';
const AGENTS = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003'];
const usdc = (s: string) => ethers.parseUnits(s, 6);
const tick = () => new Promise((r) => setImmediate(r));

/** Per-agent caps are 100 USDC each, so only the shared budget can stop an overspend. */
function fakeChain(over: { status?: number | null; throwOnSend?: boolean } = {}) {
  const sent: Array<{ amount: bigint }> = [];
  let n = 0;
  const chain: SpendChain = {
    chainId: async () => SPEND_CHAIN_ID,
    allowance: async () => usdc('100'),
    balanceOf: async () => usdc('1000'),
    ethBalance: async () => ethers.parseEther('0.01'),
    gasCost: async () => ethers.parseEther('0.0001'),
    send: async (_k, _o, _t, amount) => {
      await tick();
      if (over.throwOnSend) throw new Error('could not coalesce error (timeout)');
      n += 1;
      const hash = '0x' + n.toString(16).padStart(64, '0');
      const status = over.status === undefined ? 1 : over.status;
      if (status === 1) sent.push({ amount });
      return { hash, blockNumber: 42, status };
    },
  };
  return { chain, sent };
}

type Row = { id: string; agent: string; amount: bigint; state: 'reserved' | FinishState; tx: string | null };

/** The SQL function's contract, atomically: JS runs the check-and-insert without yielding. */
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
    async status() {
      return { budget: funded, committed: committed() };
    },
    async recordSettled(_b, agent, amount, tx) {
      rows.push({ id: `s${++n}`, agent, amount, state: 'settled', tx });
    },
    async completeWithdrawal() {},
  };
  return { store, rows, committed };
}

/** NEGATIVE CONTROL: reads the sum, yields, then writes. Concurrent spends race past each other. */
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
    async status() {
      return { budget: funded, committed };
    },
    async recordSettled() {},
    async completeWithdrawal() {},
  };
  return { store };
}

function app(opts: { chain: SpendChain; store: OwnerBudgetStore; mode: OwnerBudgetMode; builder?: string | null | Error }) {
  const a = express();
  a.use(express.json());
  // What authMiddleware sets for an agent-bound key: the agent in the path is the caller's own.
  a.use((req, _res, next) => { (req as any).agent_id = req.path.split('/')[4]; next(); });
  a.use(
    '/api/v1/agents',
    createAgentSpendRouter({
      chain: opts.chain,
      loadAgent: async () => ({ key: AGENT_KEY, walletAddress: AGENT }),
      loadOwnerWallet: async () => OWNER,
      enabled: () => true,
      loadOwnerBuilder: async () => {
        if (opts.builder instanceof Error) throw opts.builder;
        return opts.builder === undefined ? BUILDER : opts.builder;
      },
      ownerBudget: opts.store,
      budgetMode: () => opts.mode,
    }),
  );
  return a;
}

const spend = (a: express.Express, agent: string, amount: string, dry_run = false) =>
  request(a).post(`/api/v1/agents/${agent}/spend`).send({ owner_address: OWNER, to_address: PAYEE, amount_usdc: amount, dry_run });

const total = (sent: Array<{ amount: bigint }>) => sent.reduce((acc, s) => acc + s.amount, 0n);

describe('enforce: all of one owner\'s agents share one budget', () => {
  it('a second agent cannot spend what the first already spent', async () => {
    const { chain, sent } = fakeChain();
    const { store } = memoryBudget(usdc('10'));
    const a = app({ chain, store, mode: 'enforce' });

    expect((await spend(a, AGENTS[0]!, '6')).body).toMatchObject({ ok: true });
    const refused = await spend(a, AGENTS[1]!, '6');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'over_owner_budget', owner_budget: { budget_usdc: '10.0', committed_usdc: '6.0', remaining_usdc: '4.0' } });
    expect((await spend(a, AGENTS[1]!, '4')).body).toMatchObject({ ok: true });
    expect(total(sent)).toBe(usdc('10'));
  });

  it('concurrent spends across three agents never exceed the budget', async () => {
    const { chain, sent } = fakeChain();
    const { store } = memoryBudget(usdc('10'));
    const a = app({ chain, store, mode: 'enforce' });

    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(rs.filter((r) => r.body.ok === true)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409 && r.body.code === 'over_owner_budget')).toHaveLength(3);
    expect(total(sent)).toBe(usdc('10'));
  });

  it('negative control: a store that reads then writes DOES overspend under the same load', async () => {
    // If this ever stops overspending, the concurrency test above has lost its power to see a race.
    const { chain, sent } = fakeChain();
    const { store } = racyBudget(usdc('10'));
    const a = app({ chain, store, mode: 'enforce' });
    await Promise.all(Array.from({ length: 8 }, (_, i) => spend(a, AGENTS[i % 3]!, '2')));
    expect(total(sent)).toBeGreaterThan(usdc('10'));
  });

  it('a reverted receipt releases the reservation, so the budget is spendable again', async () => {
    const reverting = fakeChain({ status: 0 });
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ chain: reverting.chain, store: ledger.store, mode: 'enforce' }), AGENTS[0]!, '10');
    expect(r.status).toBe(502);
    expect(ledger.rows[0]).toMatchObject({ state: 'released' });
    expect(ledger.rows[0]!.tx).toMatch(/^0x/);

    const good = fakeChain();
    expect((await spend(app({ chain: good.chain, store: ledger.store, mode: 'enforce' }), AGENTS[1]!, '10')).body).toMatchObject({ ok: true });
  });

  it('an unknown outcome keeps counting: the send threw, so it may have landed', async () => {
    const throwing = fakeChain({ throwOnSend: true });
    const ledger = memoryBudget(usdc('10'));
    expect((await spend(app({ chain: throwing.chain, store: ledger.store, mode: 'enforce' }), AGENTS[0]!, '7')).status).toBe(502);
    expect(ledger.rows[0]).toMatchObject({ state: 'unknown' });

    const good = fakeChain();
    const r = await spend(app({ chain: good.chain, store: ledger.store, mode: 'enforce' }), AGENTS[1]!, '7');
    expect(r.status).toBe(409);
    expect(good.sent).toHaveLength(0);
  });

  it('a settled spend is recorded with its transaction', async () => {
    const { chain } = fakeChain();
    const ledger = memoryBudget(usdc('10'));
    const r = await spend(app({ chain, store: ledger.store, mode: 'enforce' }), AGENTS[0]!, '3');
    expect(r.body).toMatchObject({ ok: true, owner_budget_reservation: 'r1' });
    expect(ledger.rows[0]).toMatchObject({ state: 'settled', tx: r.body.tx_hash });
  });

  it('fails closed when the ledger cannot be read: 503, nothing sent', async () => {
    const { chain, sent } = fakeChain();
    const { store } = memoryBudget(usdc('10'));
    store.reserve = async () => {
      throw new Error('connection reset');
    };
    const r = await spend(app({ chain, store, mode: 'enforce' }), AGENTS[0]!, '1');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('owner_budget_not_checked');
    expect(sent).toHaveLength(0);
  });

  it('fails closed when the owner cannot be resolved: 503, nothing sent', async () => {
    const { chain, sent } = fakeChain();
    const r = await spend(app({ chain, store: memoryBudget(usdc('10')).store, mode: 'enforce', builder: new Error('timeout') }), AGENTS[0]!, '1');
    expect(r.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('an owner with no builder account has no budget: 403, nothing sent', async () => {
    const { chain, sent } = fakeChain();
    const r = await spend(app({ chain, store: memoryBudget(usdc('10')).store, mode: 'enforce', builder: null }), AGENTS[0]!, '1');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('no_owner_budget');
    expect(sent).toHaveLength(0);
  });

  it('a dry run reports the budget and says it would refuse, signing nothing', async () => {
    const { chain, sent } = fakeChain();
    const ledger = memoryBudget(usdc('5'));
    const a = app({ chain, store: ledger.store, mode: 'enforce' });
    const ok = await spend(a, AGENTS[0]!, '5', true);
    expect(ok.body).toMatchObject({ ok: true, would_send: true, owner_budget: { remaining_usdc: '5.0' } });
    const over = await spend(a, AGENTS[0]!, '5.000001', true);
    expect(over.body).toMatchObject({ ok: false, would_send: false, code: 'over_owner_budget' });
    expect(sent).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });
});

describe('shadow and off', () => {
  it('shadow never refuses, says what it would refuse, and records what settled', async () => {
    const { chain, sent } = fakeChain();
    const ledger = memoryBudget(usdc('1'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await spend(app({ chain, store: ledger.store, mode: 'shadow' }), AGENTS[0]!, '5');
      expect(r.body).toMatchObject({ ok: true });
      expect(sent).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('WOULD REFUSE'))).toBe(true);
      expect(ledger.rows).toEqual([expect.objectContaining({ state: 'settled', amount: usdc('5') })]);
    } finally {
      warn.mockRestore();
    }
  });

  it('shadow keeps spending when the ledger is down', async () => {
    const { chain, sent } = fakeChain();
    const { store } = memoryBudget(usdc('1'));
    store.status = async () => {
      throw new Error('down');
    };
    store.recordSettled = async () => {
      throw new Error('down');
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await spend(app({ chain, store, mode: 'shadow' }), AGENTS[0]!, '2')).body).toMatchObject({ ok: true });
      expect(sent).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('off never touches the ledger', async () => {
    const { chain } = fakeChain();
    const touched: string[] = [];
    const store = new Proxy({} as OwnerBudgetStore, { get: (_t, p) => () => { touched.push(String(p)); throw new Error('touched'); } });
    const a = app({ chain, store, mode: 'off', builder: new Error('must not be read') });
    expect((await spend(a, AGENTS[0]!, '50')).body).toMatchObject({ ok: true });
    expect(touched).toEqual([]);
  });
});

describe('revertedReceipt: only a proven status-0 receipt may release budget', () => {
  it('reads the receipt ethers v6 attaches to a reverted transaction', () => {
    expect(revertedReceipt({ code: 'CALL_EXCEPTION', receipt: { status: 0, blockNumber: 7 } })).toEqual({ blockNumber: 7 });
  });
  it.each([
    ['a timeout', { code: 'TIMEOUT' }],
    ['a call exception with no receipt', { code: 'CALL_EXCEPTION' }],
    ['a receipt that succeeded', { code: 'CALL_EXCEPTION', receipt: { status: 1 } }],
    ['a plain error', new Error('socket hang up')],
    ['nothing', null],
  ])('%s is not a revert', (_n, e) => {
    expect(revertedReceipt(e)).toBeNull();
  });
});

describe('OWNER_BUDGET_MODE', () => {
  it.each([[undefined, 'off'], ['', 'off'], ['off', 'off'], ['shadow', 'shadow'], ['ENFORCE', 'enforce'], [' enforce ', 'enforce']] as const)('%p is %s', (raw, mode) => {
    expect(ownerBudgetMode(raw)).toBe(mode);
  });
  it('a typo enforces (fail closed) and says so', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ownerBudgetMode('enfroce')).toBe('enforce');
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe('reserve_owner_spend: the SQL the guarantee depends on', () => {
  const sql = readFileSync(join(__dirname, '../supabase/migrations/20261114200000_owner_spend_ledger.sql'), 'utf8');
  const body = sql.slice(sql.indexOf('function public.reserve_owner_spend'));

  it('takes the per-owner lock before it reads either sum', () => {
    const lock = body.indexOf('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(body.indexOf('owner_funded_stake(p_builder)'));
    expect(lock).toBeLessThan(body.indexOf('from public.owner_spend_ledger'));
  });

  it('counts every state except released', () => {
    expect(body).toMatch(/state <> 'released'/);
  });

  it('funds a positive deposit only when it carries a real 0x hash; withdrawals always count', () => {
    const funded = sql.slice(sql.indexOf('function public.owner_funded_stake'), sql.indexOf('function public.reserve_owner_spend'));
    expect(funded).toMatch(/when amount < 0 then amount/);
    expect(funded).toMatch(/deposit_tx_hash ~ '\^0x\[0-9a-fA-F\]\{64\}\$'/);
    expect(funded).toMatch(/is_simulated = false/);
  });

  it('one real transfer is credited once, and a simulated row cannot take its slot', () => {
    const idx = sql.slice(sql.indexOf('stake_deposits_real_tx_hash_uniq'));
    expect(idx).toMatch(/^stake_deposits_real_tx_hash_uniq\s+on public\.stake_deposits \(lower\(deposit_tx_hash\)\)\s+where is_simulated = false\s+and deposit_tx_hash ~/);
  });

  it('completing a withdrawal releases its hold and writes the debit in ONE function, under the lock', () => {
    const fn = sql.slice(sql.indexOf('function public.complete_stake_withdrawal'), sql.indexOf('revoke all on function public.owner_funded_stake'));
    const lock = fn.indexOf('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(fn.indexOf("set state = 'released'"));
    expect(fn).toMatch(/state = 'reserved';\s+if not found then\s+raise exception/);
    expect(fn).toMatch(/insert into public\.stake_deposits[\s\S]*-p_amount, 'withdrawn', false, p_tx_hash/);
    expect(sql).toMatch(/revoke all on function public\.complete_stake_withdrawal\(uuid, uuid, bigint, text\) from public, anon, authenticated/);
  });

  it('nobody but the service role can read the ledger or call the functions', () => {
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on public\.owner_spend_ledger from anon, authenticated/);
    expect(sql).toMatch(/revoke all on function public\.reserve_owner_spend\(uuid, uuid, bigint\) from public, anon, authenticated/);
    expect(sql).not.toMatch(/create policy/i);
  });
});
