/**
 * Reponomics — REAL staking withdrawal must FAIL CLOSED (fund-stranding guard).
 *
 * Regression test for the PR #133 blocker: in the REAL_STAKING_ENABLED path,
 * withdrawStake used to insert a NEGATIVE stake_deposits row (debiting the
 * ledger) and THEN call initiateEscrowRefund — which is a STUB that never
 * broadcasts an on-chain refund — and still return ok:true. Result: the ledger
 * showed the stake withdrawn while the USDC was never sent (funds stranded).
 *
 * The fix attempts the refund FIRST and only commits the ledger debit when the
 * refund is a REAL, broadcast (non-stub) refund. On a stub / non-initiated
 * refund it writes NOTHING and returns { ok:false, error:'refund_unavailable_stub' }.
 *
 * These tests assert:
 *   - stub refund  → ok:false AND no negative stake_deposits row written
 *   - real refund  → debits (negative row) AND ok:true
 *   - the flag-OFF simulated path is unchanged
 */

// ---------------------------------------------------------------------------
// Mock config so we can flip realStakingEnabled per test.
// ---------------------------------------------------------------------------
const mockConfig: any = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseKey: 'test-key',
  realStakingEnabled: false,
  stakeEscrowAddress: '0x1111111111111111111111111111111111111111',
  baseSepoliaRpc: 'https://sepolia.base.org',
  usdcTokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  stakeMinConfirmations: 1,
};
jest.mock('../src/config', () => ({ config: mockConfig }));

// No real audit chain in unit tests.
jest.mock('../src/services/audit-emit', () => ({
  emitAuditEvent: jest.fn().mockResolvedValue({ ok: true, audit_chain_id: 1 }),
}));

// Imported transitively by stake-vault.
jest.mock('../src/services/sponsorship', () => ({
  recordSponsorship: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Flexible chainable Supabase-style db mock (same shape as the real-staking
// suite): per-table queued read results; inserts captured for assertions.
// ---------------------------------------------------------------------------
interface DbState {
  selectResults: Record<string, Array<{ data: any; error: any }>>;
  inserts: Array<{ table: string; row: any }>;
  insertError: any;
}

const dbState: DbState = { selectResults: {}, inserts: [], insertError: null };

function makeQuery(table: string) {
  const q: any = {};
  const chain = () => q;
  for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'in', 'gte']) {
    q[m] = jest.fn(chain);
  }
  const pull = () => {
    const queue = dbState.selectResults[table] ?? [];
    return queue.length ? queue.shift() : { data: null, error: null };
  };
  q.maybeSingle = jest.fn(async () => pull());
  q.single = jest.fn(async () => pull());
  q.then = (resolve: any) => resolve(pull());
  q.insert = jest.fn(async (row: any) => {
    dbState.inserts.push({ table, row });
    return { data: null, error: dbState.insertError };
  });
  return q;
}

jest.mock('../src/db', () => ({
  db: { from: jest.fn((table: string) => makeQuery(table)) },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------
import {
  withdrawStake,
  __setRefundInitiator,
  RefundInitiation,
} from '../src/services/stake-vault';

const BUILDER_ADDR = '0x9999999999999999999999999999999999999999';

function seedHappyReads() {
  dbState.selectResults['linked_bets'] = [{ data: [], error: null }]; // no open bets
  // getCurrentStake (total), getRealStake (real), then getCurrentStake (post-debit)
  dbState.selectResults['stake_deposits'] = [
    { data: [{ amount: '100000000' }], error: null }, // getCurrentStake
    { data: [{ amount: '100000000' }], error: null }, // getRealStake
    { data: [{ amount: '100000000' }, { amount: '-50000000' }], error: null }, // post
  ];
  dbState.selectResults['builders'] = [{ data: { address: BUILDER_ADDR }, error: null }];
  dbState.selectResults['repid_agents'] = [{ data: [], error: null }];
}

beforeEach(() => {
  dbState.selectResults = {};
  dbState.inserts = [];
  dbState.insertError = null;
  mockConfig.realStakingEnabled = false;
  __setRefundInitiator(); // reset to real stub
  jest.clearAllMocks();
});

afterAll(() => __setRefundInitiator());

describe('stake-vault — withdrawStake FAIL-CLOSED (fund-stranding guard)', () => {
  it('flag ON + stub refund: returns ok:false and writes NO negative stake_deposits row', async () => {
    mockConfig.realStakingEnabled = true;
    seedHappyReads();
    // Default refund initiator is the real stub (stub:true) — no override.

    const r = await withdrawStake('builder-1', 50_000_000n);

    // Refuses instead of stranding funds.
    expect(r.ok).toBe(false);
    expect(r.error).toBe('refund_unavailable_stub');
    // Critically: the ledger must be untouched — no negative debit row written.
    const debit = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(debit).toBeUndefined();
    expect(dbState.inserts.length).toBe(0);
  });

  it('flag ON + REAL (non-stub) refund: debits the ledger and returns ok:true', async () => {
    mockConfig.realStakingEnabled = true;
    seedHappyReads();
    // Inject a REAL, broadcast refund.
    const realRefund: RefundInitiation = {
      initiated: true,
      stub: false,
      amount: '50000000',
      to: BUILDER_ADDR,
      note: 'broadcast: 0xdeadbeef',
    };
    __setRefundInitiator(async () => realRefund);

    const r = await withdrawStake('builder-1', 50_000_000n);

    expect(r.ok).toBe(true);
    expect(r.refund?.stub).toBe(false);
    expect(r.refund?.initiated).toBe(true);
    // The negative debit row IS written on a confirmed real refund.
    const debit = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(debit).toBeDefined();
    expect(debit?.row.amount).toBe('-50000000');
    expect(debit?.row.is_simulated).toBe(false);
    expect(debit?.row.status).toBe('withdrawn');
  });

  it('flag ON + refund not initiated: returns ok:false and writes nothing', async () => {
    mockConfig.realStakingEnabled = true;
    seedHappyReads();
    // A refund object that did not actually initiate.
    __setRefundInitiator(async () => ({
      initiated: false,
      stub: false,
      amount: '50000000',
      to: BUILDER_ADDR,
    }));

    const r = await withdrawStake('builder-1', 50_000_000n);

    expect(r.ok).toBe(false);
    expect(r.error).toBe('refund_unavailable_stub');
    expect(dbState.inserts.length).toBe(0);
  });

  it('flag OFF: simulated withdrawal path is unchanged (still debits, no refund object)', async () => {
    mockConfig.realStakingEnabled = false;
    delete process.env.X402_REAL_RPC;
    dbState.selectResults['linked_bets'] = [{ data: [], error: null }];
    dbState.selectResults['stake_deposits'] = [
      { data: [{ amount: '100000000' }], error: null }, // getCurrentStake
      { data: [{ amount: '100000000' }, { amount: '-50000000' }], error: null }, // post
    ];
    dbState.selectResults['builders'] = [
      { data: { id: 'builder-1', current_repid: 6000, address: BUILDER_ADDR }, error: null },
    ];
    dbState.selectResults['repid_agents'] = [{ data: [], error: null }];

    const r = await withdrawStake('builder-1', 50_000_000n);

    expect(r.ok).toBe(true);
    expect(r.refund).toBeUndefined();
    const w = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(w?.row.deposit_tx_hash).toMatch(/^simulated:withdraw:/);
    expect(w?.row.is_simulated).toBe(true);
  });
});
