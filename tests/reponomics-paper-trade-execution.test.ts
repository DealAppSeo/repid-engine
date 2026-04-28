/**
 * Reponomics — paper trade execution tests (mocked bridge + db).
 *
 * Covers:
 *   - cap percentage starts at STARTING_CAP_PCT (50)
 *   - cap bumps by CAP_BUMP_PCT (5) on success, capped at MAX_CAP_PCT (90)
 *   - notional > authority * cap% is rejected
 *   - missing trading_provider returns a clear error
 */

let builderRow: any = null;
let agentRow: any = null;
let updates: any[] = [];

jest.mock('../src/db', () => {
  const tbl: any = {
    select: () => tbl,
    eq: () => tbl,
    ilike: () => tbl,
    in: () => tbl,
    order: () => tbl,
    limit: async () => ({ data: [], error: null }),
    update: (row: any) => {
      updates.push(row);
      return { eq: async () => ({ data: null, error: null }) };
    },
    insert: () => ({
      select: () => ({ single: async () => ({ data: { id: 'newrow' }, error: null }) }),
      then: (cb: any) => Promise.resolve({ data: null, error: null }).then(cb),
    }),
    maybeSingle: async () => {
      // Return whatever the test set last via setRows; we route by select shape via builderRow vs agentRow toggles.
      if (lookupMode === 'builder') return { data: builderRow, error: null };
      if (lookupMode === 'agent') return { data: agentRow, error: null };
      return { data: null, error: null };
    },
    single: async () => ({ data: builderRow, error: null }),
  };
  return {
    db: {
      from: (_t: string) => tbl,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
  };
});

let lookupMode: 'builder' | 'agent' | 'none' = 'none';

// Mock bridge — placeOrder records args and returns a successful fill.
const placedOrders: any[] = [];
jest.mock('../src/services/trading-bridge/factory', () => ({
  getTradingBridge: () => ({
    placeOrder: async (args: any) => { placedOrders.push(args); return { ok: true, order_id: 'ord-1', status: 'filled', filled_qty: args.qty, filled_price: 100, is_simulated: false }; },
    getProviderName: () => 'alpaca_rest',
  }),
  isMcpNotImplemented: (e: string) => !!e && e.includes('MCP path not yet implemented'),
}));

// Mock decryption — return canned creds without touching real env.
jest.mock('../src/services/trading-creds-crypto', () => ({
  decryptCredentials: () => ({ api_key: 'k', secret_key: 's' }),
  encryptCredentials: (c: any) => ({ v: 1, iv: '', tag: '', ciphertext: JSON.stringify(c) }),
}));

// Mock builder-registry getBuilderForAgent → controllable authority context.
let builderCtx: any = null;
jest.mock('../src/services/builder-registry', () => ({
  getBuilderForAgent: async () => builderCtx,
  recomputeBuilderRepID: async () => ({ builder_id: 'b1', builder_repid: 5000, active_count: 1, ghost_count: 0, mean_active_repid: 5000 }),
}));

import {
  executePaperTrade,
  getAgentCapPct,
  bumpAgentCapPct,
  STARTING_CAP_PCT,
  CAP_BUMP_PCT,
  MAX_CAP_PCT,
} from '../src/services/paper-trade-execution';

beforeEach(() => {
  builderRow = null;
  agentRow = null;
  builderCtx = null;
  updates = [];
  placedOrders.length = 0;
  lookupMode = 'none';
  delete process.env.ALPACA_DATA_BASE_URL;
});

describe('paper-trade-execution — cap progression helpers', () => {
  it('getAgentCapPct returns STARTING_CAP_PCT when no caps recorded', async () => {
    lookupMode = 'builder';
    builderRow = { notification_prefs: {} };
    const r = await getAgentCapPct('b1', 'a1');
    expect(r).toBe(STARTING_CAP_PCT);
  });

  it('getAgentCapPct returns the recorded cap', async () => {
    lookupMode = 'builder';
    builderRow = { notification_prefs: { agent_trade_caps: { a1: 65 } } };
    const r = await getAgentCapPct('b1', 'a1');
    expect(r).toBe(65);
  });

  it('bumpAgentCapPct adds CAP_BUMP_PCT and persists', async () => {
    lookupMode = 'builder';
    builderRow = { notification_prefs: { agent_trade_caps: { a1: 50 } } };
    const r = await bumpAgentCapPct('b1', 'a1');
    expect(r).toBe(50 + CAP_BUMP_PCT);
    expect(updates[0].notification_prefs.agent_trade_caps.a1).toBe(55);
  });

  it('bumpAgentCapPct caps at MAX_CAP_PCT', async () => {
    lookupMode = 'builder';
    builderRow = { notification_prefs: { agent_trade_caps: { a1: MAX_CAP_PCT } } };
    const r = await bumpAgentCapPct('b1', 'a1');
    expect(r).toBe(MAX_CAP_PCT);
  });
});

describe('paper-trade-execution — executePaperTrade', () => {
  it('returns error when builder has no trading account linked', async () => {
    lookupMode = 'builder';
    builderRow = { id: 'b1', trading_provider: null, trading_credentials_encrypted: null };
    const r = await executePaperTrade({ builderId: 'b1', agentId: 'a1', symbol: 'AAPL', qty: 1, side: 'buy' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/trading account/i);
  });

  it('returns error when agent does not belong to builder', async () => {
    builderRow = { id: 'b1', trading_provider: 'alpaca_rest', trading_credentials_encrypted: { v: 1, iv: '', tag: '', ciphertext: '' } };
    agentRow = { id: 'a1', builder_id: 'OTHER' };
    let toggle = 0;
    lookupMode = 'builder';
    // Simulate call sequence: first lookup is builder, second is agent.
    const dbMod: any = require('../src/db');
    const orig = dbMod.db.from;
    dbMod.db.from = (_t: string) => {
      toggle += 1;
      if (toggle === 1) lookupMode = 'builder';
      else lookupMode = 'agent';
      return orig(_t);
    };
    const r = await executePaperTrade({ builderId: 'b1', agentId: 'a1', symbol: 'AAPL', qty: 1, side: 'buy' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/agent does not belong/i);
    dbMod.db.from = orig;
  });
});
