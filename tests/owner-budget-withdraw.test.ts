/**
 * A real stake withdrawal writes ONE record before any USDC moves: the debit row (status
 * 'withdrawing'). It counts at once in the owner's shared budget and in the refund bound, so the
 * stake can be neither spent by agents nor refunded twice. In enforce mode it is written by
 * begin_stake_withdrawal under the per-owner lock, only if the stake left still covers committed
 * agent spend. After the refund it is stamped 'withdrawn', or zeroed as 'withdraw_failed' when the
 * refund definitely did not happen. Mocked db and refund.
 */
const mockOrder: string[] = [];
let mockMode = 'enforce';
const mockBudget = {
  reserve: jest.fn(),
  finish: jest.fn(),
  status: jest.fn(async () => ({ budget: 100_000_000n, committed: 0n })),
  recordSettled: jest.fn(),
  beginWithdrawal: jest.fn(async () => { mockOrder.push('begin'); return { ok: true, debitId: 'debit-1', funded: 50_000_000n, committed: 0n }; }),
};
jest.mock('../src/services/owner-budget', () => ({ ownerBudgetMode: () => mockMode, supabaseOwnerBudget: mockBudget }));
jest.mock('../src/config', () => ({ config: { realStakingEnabled: true, usdcTokenAddress: '0x' + 'c'.repeat(40), stakeEscrowAddress: '0x' + 'e'.repeat(40), stakeMinConfirmations: 1 } }));
jest.mock('../src/services/audit-emit', () => ({ emitAuditEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/sponsorship', () => ({ recordSponsorship: jest.fn() }));
jest.mock('../src/services/escrow-refunder', () => ({ escrowRefund: jest.fn() }));

const mockDb = { insertError: null as any, updates: [] as Array<{ row: any; id: unknown }> };
jest.mock('../src/db', () => {
  const rows: Record<string, any> = {
    linked_bets: { data: [], error: null },
    stake_deposits: { data: [{ amount: '100000000', deposit_tx_hash: '0x' + 'a'.repeat(64) }], error: null },
    builders: { data: { address: '0x' + '9'.repeat(40) }, error: null },
    repid_agents: { data: [], error: null },
  };
  const make = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'in', 'gte', 'is']) q[m] = () => q;
    q.maybeSingle = async () => rows[table] ?? { data: null, error: null };
    q.single = q.maybeSingle;
    q.then = (resolve: any) => resolve(rows[table] ?? { data: [], error: null });
    q.insert = async (_row: any) => { mockOrder.push(`insert:${table}`); return { data: null, error: table === 'stake_deposits' ? mockDb.insertError : null }; };
    q.update = (row: any) => {
      mockOrder.push(`update:${table}:${row.status}`);
      const u: any = { eq: (_c: string, id: unknown) => { mockDb.updates.push({ row, id }); return u; }, then: (res: any) => res({ data: null, error: null }) };
      return u;
    };
    return q;
  };
  return { db: { from: (t: string) => make(t) } };
});

import { withdrawStake, __setRefundInitiator } from '../src/services/stake-vault';

const sent = { initiated: true, stub: false, amount: '50000000', to: '0x' + '9'.repeat(40), txHash: '0x' + 'f'.repeat(64) };
let refunds = 0;
const refundWith = (r: any) => __setRefundInitiator(async () => { refunds += 1; mockOrder.push('refund'); return r; });
const steps = () => mockOrder.filter((s) => s !== 'insert:stake_authority_snapshots');

beforeEach(() => {
  mockOrder.length = 0;
  mockDb.updates.length = 0;
  mockMode = 'enforce';
  mockDb.insertError = null;
  refunds = 0;
  jest.clearAllMocks();
  refundWith(sent);
});

describe('enforce', () => {
  it('writes the debit under the lock BEFORE the refund, then stamps it with the refund', async () => {
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(true);
    expect(mockBudget.beginWithdrawal).toHaveBeenCalledWith('builder-1', 50_000_000n);
    expect(steps()).toEqual(['begin', 'refund', 'update:stake_deposits:withdrawn']);
    expect(mockDb.updates[0]).toEqual({ row: { status: 'withdrawn', deposit_tx_hash: sent.txHash }, id: 'debit-1' });
    expect(mockBudget.reserve).not.toHaveBeenCalled(); // no separate ledger hold
  });

  it('refuses when the stake backs agent spend: no debit, no refund', async () => {
    mockBudget.beginWithdrawal.mockImplementationOnce(async () => ({ ok: false, debitId: null, funded: 100_000_000n, committed: 80_000_000n }) as any);
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r).toMatchObject({ ok: false, error: 'stake_backs_agent_spend' });
    expect(refunds).toBe(0);
  });

  it('fails closed when the budget cannot be read: no refund', async () => {
    mockBudget.beginWithdrawal.mockImplementationOnce(async () => { throw new Error('down'); });
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r).toMatchObject({ ok: false, error: 'owner_budget_not_checked' });
    expect(refunds).toBe(0);
  });

  it('a refund that was not sent voids the debit', async () => {
    refundWith({ initiated: false, stub: false, amount: '50000000', note: 'rpc refused' });
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(false);
    expect(steps()).toEqual(['begin', 'refund', 'update:stake_deposits:withdraw_failed']);
    expect(mockDb.updates[0]).toEqual({ row: { amount: '0', status: 'withdraw_failed' }, id: 'debit-1' });
  });

  it('a refund that was broadcast but is unconfirmed keeps the debit counting and is NOT reported as done', async () => {
    refundWith({ ...sent, unconfirmed: true, note: 'timeout' });
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(steps()).toEqual(['begin', 'refund', 'update:stake_deposits:withdraw_unconfirmed']);
    expect(r).toMatchObject({ ok: false, error: 'refund_unconfirmed' });
    expect(r.refund?.unconfirmed).toBe(true);
  });
});

describe('off', () => {
  it('writes the pending debit BEFORE the refund and stamps it after', async () => {
    mockMode = 'off';
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(true);
    expect(mockBudget.beginWithdrawal).not.toHaveBeenCalled();
    expect(steps()).toEqual(['insert:stake_deposits', 'refund', 'update:stake_deposits:withdrawn']);
  });

  it('if the pending debit cannot be written, NO refund is attempted', async () => {
    mockMode = 'off';
    mockDb.insertError = { message: 'db down' };
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(false);
    expect(refunds).toBe(0);
  });
});

describe('every spelling of one builder id', () => {
  const id = '11111111-2222-4333-8444-555555555555';

  it('reaches the budget as one canonical id', async () => {
    await withdrawStake(`{${id.toUpperCase()}}`, 50_000_000n);
    await withdrawStake(id.replace(/-/g, ''), 50_000_000n);
    expect(mockBudget.beginWithdrawal.mock.calls.map((c: any[]) => c[0])).toEqual([id, id]);
  });

  it('shares ONE withdrawal lock (no interleaving)', async () => {
    const log: string[] = [];
    __setRefundInitiator(async () => {
      log.push('start');
      await new Promise((res) => setTimeout(res, 20));
      log.push('end');
      return sent;
    });
    await Promise.all([withdrawStake(id, 50_000_000n), withdrawStake(id.toUpperCase().replace(/-/g, ''), 50_000_000n)]);
    expect(log).toEqual(['start', 'end', 'start', 'end']);
  });
});
