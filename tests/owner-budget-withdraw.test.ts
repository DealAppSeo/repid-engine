/**
 * A real stake withdrawal, with OWNER_BUDGET_MODE=enforce, holds its amount in the owner's shared
 * budget (the same reserve_owner_spend, the same per-owner lock) BEFORE the refund is sent, so a
 * concurrent agent spend cannot take it. The hold is released only after the debit row is written,
 * or when the refund definitely did not happen; anything unclear keeps it. Mocked db and refund.
 */
const mockOrder: string[] = [];
let mockMode = 'enforce';
const mockBudget = {
  reserve: jest.fn(async () => { mockOrder.push('reserve'); return { ok: true, id: 'hold-1', budget: 100_000_000n, committed: 50_000_000n }; }),
  finish: jest.fn(async (_id: string, state: string) => { mockOrder.push(`finish:${state}`); }),
  status: jest.fn(async () => ({ budget: 100_000_000n, committed: 0n })),
  recordSettled: jest.fn(),
  completeWithdrawal: jest.fn(async () => { mockOrder.push('complete'); }),
};
jest.mock('../src/services/owner-budget', () => ({ ownerBudgetMode: () => mockMode, supabaseOwnerBudget: mockBudget }));
jest.mock('../src/config', () => ({ config: { realStakingEnabled: true, usdcTokenAddress: '0x' + 'c'.repeat(40),stakeEscrowAddress: '0x' + 'e'.repeat(40), stakeMinConfirmations: 1 } }));
jest.mock('../src/services/audit-emit', () => ({ emitAuditEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/sponsorship', () => ({ recordSponsorship: jest.fn() }));
jest.mock('../src/services/escrow-refunder', () => ({ escrowRefund: jest.fn() }));

const mockDb = { insertError: null as any };
jest.mock('../src/db', () => {
  const rows: Record<string, any> = {
    linked_bets: { data: [], error: null },
    stake_deposits: { data: [{ amount: '100000000' }], error: null },
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
    return q;
  };
  return { db: { from: (t: string) => make(t) } };
});

import { withdrawStake, __setRefundInitiator, WITHDRAWAL_HOLD_AGENT } from '../src/services/stake-vault';

const sent = { initiated: true, stub: false, amount: '50000000', to: '0x' + '9'.repeat(40), txHash: '0x' + 'f'.repeat(64) };
let refunds = 0;
const refundWith = (r: any) => __setRefundInitiator(async () => { refunds += 1; mockOrder.push('refund'); return r; });

beforeEach(() => {
  mockOrder.length = 0;
  mockMode = 'enforce';
  mockDb.insertError = null;
  refunds = 0;
  jest.clearAllMocks();
  refundWith(sent);
});

it('holds the amount BEFORE the refund, then writes the debit and releases the hold in ONE step', async () => {
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r.ok).toBe(true);
  expect(mockBudget.reserve).toHaveBeenCalledWith('builder-1', WITHDRAWAL_HOLD_AGENT, 50_000_000n);
  expect(mockBudget.completeWithdrawal).toHaveBeenCalledWith('hold-1', 'builder-1', 50_000_000n, sent.txHash);
  // No separate debit insert and no separate release: those are the two steps that could
  // disagree (Grok r6). The authority snapshot written afterwards is not part of the invariant.
  expect(mockOrder.filter((s) => s !== 'insert:stake_authority_snapshots')).toEqual(['reserve', 'refund', 'complete']);
});

it('refuses when the stake backs agent spend: no refund is sent', async () => {
  mockBudget.reserve.mockImplementationOnce(async () => ({ ok: false, id: null, budget: 100_000_000n, committed: 80_000_000n }) as any);
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r).toMatchObject({ ok: false, error: 'stake_backs_agent_spend' });
  expect(refunds).toBe(0);
  expect(mockOrder.some((s) => s.startsWith('insert'))).toBe(false);
});

it('fails closed when the budget cannot be read: no refund is sent', async () => {
  mockBudget.reserve.mockImplementationOnce(async () => { throw new Error('down'); });
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r).toMatchObject({ ok: false, error: 'owner_budget_not_checked' });
  expect(refunds).toBe(0);
});

it('a refund that was not sent releases the hold and writes no debit', async () => {
  refundWith({ initiated: false, stub: false, amount: '50000000', note: 'rpc refused' });
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r.ok).toBe(false);
  expect(mockOrder).toEqual(['reserve', 'refund', 'finish:released']);
});

it('a refund that WAS sent but could not be recorded keeps the hold counting (unknown)', async () => {
  mockBudget.completeWithdrawal.mockImplementationOnce(async () => { mockOrder.push('complete'); throw new Error('db down'); });
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r.ok).toBe(false);
  expect(mockOrder).toEqual(['reserve', 'refund', 'complete', 'finish:unknown']);
});

it('with the mode off, the old single debit insert is used', async () => {
  mockMode = 'off';
  await withdrawStake('builder-1', 50_000_000n);
  expect(mockBudget.completeWithdrawal).not.toHaveBeenCalled();
  expect(mockOrder).toContain('insert:stake_deposits');
});

it('with the mode off, no hold is taken', async () => {
  mockMode = 'off';
  const r = await withdrawStake('builder-1', 50_000_000n);
  expect(r.ok).toBe(true);
  expect(mockBudget.reserve).not.toHaveBeenCalled();
  expect(mockBudget.finish).not.toHaveBeenCalled();
});
