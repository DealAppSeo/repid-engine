/**
 * Reponomics — REAL staking (verified-deposit escrow model).
 *
 * Covers the deposit-verifier on-chain checks (ethers provider mocked) and the
 * stake-vault deposit/withdraw routing under REAL_STAKING_ENABLED.
 *
 * Verified matrix:
 *   - verified deposit accepted (correct token/recipient/amount/confirmed +
 *     escrow balance increased)  → is_simulated=false, verified=true
 *   - wrong-token / wrong-recipient / short-amount / unconfirmed / replayed
 *     tx  → rejected
 *   - flag OFF preserves today's simulated accounting behavior
 */

import { ethers } from 'ethers';

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

// ---------------------------------------------------------------------------
// Mock audit-emit (no real audit chain in unit tests).
// ---------------------------------------------------------------------------
jest.mock('../src/services/audit-emit', () => ({
  emitAuditEvent: jest.fn().mockResolvedValue({ ok: true, audit_chain_id: 1 }),
}));

// ---------------------------------------------------------------------------
// Mock sponsorship (imported transitively by stake-vault).
// ---------------------------------------------------------------------------
jest.mock('../src/services/sponsorship', () => ({
  recordSponsorship: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Flexible chainable Supabase-style db mock.
//
// Each .from(table) returns a thenable query builder. Query results are pulled
// from a per-table queue (dbState.selectResults); inserts are captured in
// dbState.inserts.
// ---------------------------------------------------------------------------
interface DbState {
  // table -> array of {data,error} to return for successive terminal reads
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
  // terminal read when the chain is awaited directly (e.g. .select().eq())
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
import { depositStake, withdrawStake } from '../src/services/stake-vault';
import {
  verifyDeposit,
  __setProviderFactory,
  EthProviderLike,
} from '../src/services/deposit-verifier';

// ---------------------------------------------------------------------------
// On-chain fixtures.
// ---------------------------------------------------------------------------
const ESCROW = mockConfig.stakeEscrowAddress;
const USDC = mockConfig.usdcTokenAddress;
const OTHER_TOKEN = '0x2222222222222222222222222222222222222222';
const BUILDER_ADDR = '0x9999999999999999999999999999999999999999';
const VALID_TX = '0x' + 'a'.repeat(64);
const iface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function transferLog(token: string, from: string, to: string, value: bigint) {
  const enc = iface.encodeEventLog('Transfer', [from, to, value]);
  return { address: token, topics: [...enc.topics], data: enc.data };
}

/**
 * Build a mock provider. `opts` tunes the scenario.
 */
function mockProvider(opts: {
  receipt?: any;
  head?: number;
  balBefore?: bigint;
  balAfter?: bigint;
} = {}): EthProviderLike {
  const {
    receipt = {
      status: 1,
      blockNumber: 100,
      logs: [transferLog(USDC, BUILDER_ADDR, ESCROW, 100_000_000n)],
    },
    head = 105,
    balBefore = 0n,
    balAfter = 100_000_000n,
  } = opts;
  return {
    getTransactionReceipt: jest.fn(async () => receipt),
    getBlockNumber: jest.fn(async () => head),
    call: jest.fn(async (tx: { to: string; data: string; blockTag?: any }) => {
      // balanceOf(escrow): return balAfter at deposit block, balBefore one earlier.
      const bal = tx.blockTag === 100 ? balAfter : balBefore;
      return iface.encodeFunctionResult('balanceOf', [bal]);
    }),
  };
}

function seedBuilderFound() {
  dbState.selectResults['builders'] = [
    { data: { id: 'builder-1', current_repid: 6000, address: BUILDER_ADDR }, error: null },
  ];
}

beforeEach(() => {
  dbState.selectResults = {};
  dbState.inserts = [];
  dbState.insertError = null;
  mockConfig.realStakingEnabled = false;
  __setProviderFactory(() => mockProvider());
  jest.clearAllMocks();
});

afterAll(() => __setProviderFactory());

// ===========================================================================
// deposit-verifier unit tests (provider mocked directly)
// ===========================================================================
describe('deposit-verifier — verifyDeposit', () => {
  const base = {
    txHash: VALID_TX,
    claimedAmount: 100_000_000n,
    escrowAddress: ESCROW,
    tokenAddress: USDC,
    minConfirmations: 1,
  };

  it('accepts a correct verified deposit', async () => {
    __setProviderFactory(() => mockProvider());
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(true);
    expect(r.observedAmount).toBe(100_000_000n);
  });

  it('rejects wrong token (transfer to escrow but not USDC)', async () => {
    __setProviderFactory(() =>
      mockProvider({
        receipt: {
          status: 1,
          blockNumber: 100,
          logs: [transferLog(OTHER_TOKEN, BUILDER_ADDR, ESCROW, 100_000_000n)],
        },
      }),
    );
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/different token|no USDC transfer/i);
  });

  it('rejects wrong recipient (USDC transfer not to escrow)', async () => {
    __setProviderFactory(() =>
      mockProvider({
        receipt: {
          status: 1,
          blockNumber: 100,
          logs: [transferLog(USDC, BUILDER_ADDR, OTHER_TOKEN, 100_000_000n)],
        },
      }),
    );
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/did not land at the escrow/i);
  });

  it('rejects short amount (transferred < claimed)', async () => {
    __setProviderFactory(() =>
      mockProvider({
        receipt: {
          status: 1,
          blockNumber: 100,
          logs: [transferLog(USDC, BUILDER_ADDR, ESCROW, 40_000_000n)],
        },
        balAfter: 40_000_000n,
      }),
    );
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/< claimed/);
  });

  it('rejects unconfirmed tx (head too close)', async () => {
    __setProviderFactory(() => mockProvider({ head: 100 - 1 })); // 0 confirmations
    const r = await verifyDeposit({ ...base, minConfirmations: 3 });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/insufficient confirmations/i);
  });

  it('rejects tx not found (unmined)', async () => {
    __setProviderFactory(() => mockProvider({ receipt: null }));
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('rejects reverted tx (status 0)', async () => {
    __setProviderFactory(() =>
      mockProvider({ receipt: { status: 0, blockNumber: 100, logs: [] } }),
    );
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/reverted/i);
  });

  it('rejects when escrow balance did not increase by claimed amount', async () => {
    // Transfer log says 100 USDC to escrow, but balanceOf shows no delta.
    __setProviderFactory(() => mockProvider({ balBefore: 500n, balAfter: 500n }));
    const r = await verifyDeposit(base);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/balance delta/i);
  });

  it('rejects malformed tx_hash', async () => {
    const r = await verifyDeposit({ ...base, txHash: 'not-a-hash' });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/invalid or missing tx_hash/i);
  });
});

// ===========================================================================
// stake-vault deposit routing
// ===========================================================================
describe('stake-vault — depositStake real-staking routing', () => {
  it('flag OFF: preserves simulated accounting (is_simulated true, simulated tx_hash)', async () => {
    mockConfig.realStakingEnabled = false;
    delete process.env.X402_REAL_RPC;
    seedBuilderFound();
    // getCurrentStake read + snapshotAuthority reads
    dbState.selectResults['stake_deposits'] = [{ data: [{ amount: '100000000' }], error: null }];
    dbState.selectResults['repid_agents'] = [{ data: [], error: null }];

    const r = await depositStake(BUILDER_ADDR, 100_000_000n);
    expect(r.ok).toBe(true);
    expect(r.is_simulated).toBe(true);
    const dep = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(dep?.row.deposit_tx_hash).toMatch(/^simulated:deposit:/);
    expect(dep?.row.is_simulated).toBe(true);
  });

  it('flag ON: accepts a verified deposit as REAL (is_simulated=false)', async () => {
    mockConfig.realStakingEnabled = true;
    __setProviderFactory(() => mockProvider());
    seedBuilderFound();
    // duplicate-check read (stake_deposits by tx_hash) -> none
    dbState.selectResults['stake_deposits'] = [
      { data: [], error: null }, // duplicate check
      { data: [{ amount: '100000000' }], error: null }, // getCurrentStake
    ];
    dbState.selectResults['repid_agents'] = [{ data: [], error: null }];

    const r = await depositStake(BUILDER_ADDR, 100_000_000n, VALID_TX);
    expect(r.ok).toBe(true);
    expect(r.is_simulated).toBe(false);
    expect(r.verified).toBe(true);
    const dep = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(dep?.row.is_simulated).toBe(false);
    expect(dep?.row.deposit_tx_hash).toBe(VALID_TX);
    expect(dep?.row.token_address).toBe(USDC);
  });

  it('flag ON: rejects a simulated tx_hash', async () => {
    mockConfig.realStakingEnabled = true;
    seedBuilderFound();
    const r = await depositStake(BUILDER_ADDR, 100_000_000n, 'simulated:deposit:123');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/real on-chain tx_hash is required/i);
    expect(dbState.inserts.length).toBe(0);
  });

  it('flag ON: rejects a missing tx_hash', async () => {
    mockConfig.realStakingEnabled = true;
    seedBuilderFound();
    const r = await depositStake(BUILDER_ADDR, 100_000_000n);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/real on-chain tx_hash is required/i);
  });

  it('flag ON: rejects a replayed (duplicate) tx_hash', async () => {
    mockConfig.realStakingEnabled = true;
    __setProviderFactory(() => mockProvider());
    seedBuilderFound();
    // duplicate check returns an existing row
    dbState.selectResults['stake_deposits'] = [
      { data: [{ id: 'existing-dep' }], error: null },
    ];
    const r = await depositStake(BUILDER_ADDR, 100_000_000n, VALID_TX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate tx_hash/i);
    expect(dbState.inserts.length).toBe(0);
  });

  it('flag ON: rejects an on-chain-unverified deposit (short amount)', async () => {
    mockConfig.realStakingEnabled = true;
    __setProviderFactory(() =>
      mockProvider({
        receipt: {
          status: 1,
          blockNumber: 100,
          logs: [transferLog(USDC, BUILDER_ADDR, ESCROW, 10_000_000n)],
        },
        balAfter: 10_000_000n,
      }),
    );
    seedBuilderFound();
    dbState.selectResults['stake_deposits'] = [{ data: [], error: null }]; // dup check ok
    const r = await depositStake(BUILDER_ADDR, 100_000_000n, VALID_TX);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verification failed/i);
    expect(dbState.inserts.length).toBe(0);
  });
});

// ===========================================================================
// stake-vault withdrawal routing
// ===========================================================================
describe('stake-vault — withdrawStake real-staking routing', () => {
  it('honors the open-bets one-way valve (blocks withdrawal)', async () => {
    mockConfig.realStakingEnabled = true;
    dbState.selectResults['linked_bets'] = [{ data: [{ id: 'bet-1' }], error: null }];
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/open bets/i);
  });

  it('flag ON + stub refund: FAILS CLOSED — refuses and writes no ledger debit', async () => {
    // Fund-stranding guard (PR #133 fix): while initiateEscrowRefund is still a
    // stub (never broadcasts on-chain), withdrawStake must NOT debit the ledger.
    // Full happy/stub matrix lives in reponomics-withdraw-fail-closed.test.ts.
    mockConfig.realStakingEnabled = true;
    dbState.selectResults['linked_bets'] = [{ data: [], error: null }]; // no open bets
    // getCurrentStake (total), getRealStake (real)
    dbState.selectResults['stake_deposits'] = [
      { data: [{ amount: '100000000' }], error: null }, // getCurrentStake
      { data: [{ amount: '100000000' }], error: null }, // getRealStake
    ];
    dbState.selectResults['builders'] = [{ data: { address: BUILDER_ADDR }, error: null }];
    dbState.selectResults['repid_agents'] = [{ data: [], error: null }];

    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('refund_unavailable_stub');
    expect(r.refund?.stub).toBe(true);
    // No negative stake_deposits row was written — ledger untouched.
    const w = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(w).toBeUndefined();
  });

  it('flag ON: rejects withdrawal exceeding real stake', async () => {
    mockConfig.realStakingEnabled = true;
    dbState.selectResults['linked_bets'] = [{ data: [], error: null }];
    dbState.selectResults['stake_deposits'] = [
      { data: [{ amount: '100000000' }], error: null }, // getCurrentStake (total incl simulated)
      { data: [{ amount: '10000000' }], error: null },  // getRealStake (only 10 real)
    ];
    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeds real/i);
  });

  it('flag OFF: preserves simulated withdrawal behavior', async () => {
    mockConfig.realStakingEnabled = false;
    delete process.env.X402_REAL_RPC;
    dbState.selectResults['linked_bets'] = [{ data: [], error: null }];
    dbState.selectResults['stake_deposits'] = [
      { data: [{ amount: '100000000' }], error: null }, // getCurrentStake
      { data: [{ amount: '100000000' }, { amount: '-50000000' }], error: null }, // post
    ];
    dbState.selectResults['builders'] = [{ data: { id: 'builder-1', current_repid: 6000, address: BUILDER_ADDR }, error: null }];
    dbState.selectResults['repid_agents'] = [{ data: [], error: null }];

    const r = await withdrawStake('builder-1', 50_000_000n);
    expect(r.ok).toBe(true);
    expect(r.refund).toBeUndefined();
    const w = dbState.inserts.find((i) => i.table === 'stake_deposits');
    expect(w?.row.deposit_tx_hash).toMatch(/^simulated:withdraw:/);
    expect(w?.row.is_simulated).toBe(true);
  });
});
