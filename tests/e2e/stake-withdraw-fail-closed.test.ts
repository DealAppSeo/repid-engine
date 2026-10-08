/**
 * Withdrawal money-safety invariant (REAL staking path): the stake ledger records a
 * withdrawal ONLY when a real escrow→builder refund actually broadcast. No real send ⇒
 * no debit ⇒ the stake stays fully backed. This is the one property the LIVE testnet
 * withdrawal depends on, so it is pinned here deterministically (no chain, no live key):
 *
 *   refund STUB (signer key unset)        → REFUSED, NO ledger debit written
 *   refund REFUSED (initiated:false)      → REFUSED, NO ledger debit (wrong chain / signer≠escrow)
 *   refund BROADCAST (real tx hash)       → ledger debit written, tagged with that tx hash
 *   amount > real (verified) stake        → REFUSED before any refund is even attempted
 *
 * REAL_STAKING_ENABLED is read at config-load, so services are required() after it is set.
 * The escrow send is swapped via the real __setRefundInitiator seam (no live signer needed).
 */

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'REAL_STAKING_ENABLED', 'X402_REAL_RPC'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.REAL_STAKING_ENABLED = 'true'; // exercise the REAL withdraw branch
delete process.env.X402_REAL_RPC;
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__WD_STORE__;
});

jest.mock('../../src/db', () => {
  const store: Record<string, any[]> = {
    builders: [],
    repid_agents: [],
    stake_deposits: [],
    linked_bets: [],
    stake_authority_snapshots: [],
    audit_events: [],
    agent_stakes: [],
  };
  const tbl = (name: string): any[] => (store[name] ||= []);
  class Q {
    table: string;
    private _filters: Array<(r: any) => boolean> = [];
    private _op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private _payload: any = null;
    private _inserted: any = null;
    private _limit: number | null = null;
    private _single = false;
    private _maybe = false;
    private _selected = false;
    constructor(table: string) { this.table = table; }
    select() { this._selected = true; return this; }
    eq(col: string, val: any) { this._filters.push((r) => r[col] === val); return this; }
    ilike(col: string, val: any) { const v = String(val).toLowerCase(); this._filters.push((r) => String(r[col] ?? '').toLowerCase() === v); return this; }
    in(col: string, vals: any[]) { this._filters.push((r) => vals.includes(r[col])); return this; }
    limit(n: number) { this._limit = n; return this; }
    order() { return this; } range() { return this; } not() { return this; }
    gte() { return this; } lte() { return this; } gt() { return this; } lt() { return this; } is() { return this; }
    maybeSingle() { this._maybe = true; return this; }
    single() { this._single = true; return this; }
    insert(payload: any) {
      this._op = 'insert';
      const t = tbl(this.table);
      const rows = Array.isArray(payload) ? payload : [payload];
      const inserted = rows.map((r) => { const row = { ...r }; if (row.id === undefined) row.id = `${this.table}-${t.length + 1}`; t.push(row); return row; });
      this._inserted = Array.isArray(payload) ? inserted : inserted[0];
      return this;
    }
    update(payload: any) { this._op = 'update'; this._payload = payload; return this; }
    delete() { this._op = 'delete'; return this; }
    private _exec(): { data: any; error: any; count?: number } {
      const t = tbl(this.table);
      if (this._op === 'insert') {
        if (this._selected || this._single || this._maybe) {
          const r = Array.isArray(this._inserted) ? this._inserted[0] ?? null : this._inserted;
          return { data: r, error: null };
        }
        return { data: null, error: null };
      }
      let rows = t.filter((r) => this._filters.every((f) => f(r)));
      if (this._op === 'update') { rows.forEach((r) => Object.assign(r, this._payload)); return { data: rows, error: null }; }
      if (this._op === 'delete') { for (const r of rows) { const i = t.indexOf(r); if (i >= 0) t.splice(i, 1); } return { data: null, error: null }; }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      if (this._single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      if (this._maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null, count: rows.length };
    }
    then(onF?: (v: any) => any, onR?: (e: any) => any) { return Promise.resolve(this._exec()).then(onF, onR); }
    catch(onR: (e: any) => any) { return this.then(undefined, onR); }
    finally(fn: () => void) { return this.then().finally(fn); }
  }
  const db = { from: (table: string) => new Q(table) };
  (globalThis as any).__WD_STORE__ = store;
  return { db };
});

let withdrawStake: typeof import('../../src/services/stake-vault').withdrawStake;
let getRealStake: typeof import('../../src/services/stake-vault').getRealStake;
let __setRefundInitiator: typeof import('../../src/services/stake-vault').__setRefundInitiator;

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__WD_STORE__;
const BUILDER = 'builder-1';
const PAYEE = '0x' + '2'.repeat(40);
const STAKE = 100_000_000n; // 100 USDC (6dp), REAL

function seed() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  s.builders.push({ id: BUILDER, address: PAYEE, current_repid: 6000, auth_method: 'token_only' });
  s.repid_agents.push({ id: 'agent-1', agent_name: 'A', current_repid: 1000, builder_id: BUILDER, wisdom_score: 1000, character_score: 1000, last_active_at: null });
  // One REAL stake row (is_simulated=false) — the escrow custodies this.
  s.stake_deposits.push({ id: 'dep-1', builder_id: BUILDER, amount: STAKE.toString(), status: 'active', is_simulated: false, deposit_tx_hash: '0xdeposit' });
}
const debitRows = () => store().stake_deposits.filter((r) => BigInt(r.amount) < 0n);

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const m = require('../../src/services/stake-vault');
  withdrawStake = m.withdrawStake;
  getRealStake = m.getRealStake;
  __setRefundInitiator = m.__setRefundInitiator;
  /* eslint-enable @typescript-eslint/no-var-requires */
});
beforeEach(() => seed());
afterEach(() => __setRefundInitiator(undefined));

describe('withdrawStake REAL path — ledger debit only on a real broadcast refund', () => {
  it('refund STUB → REFUSED, no ledger debit, stake stays fully backed', async () => {
    __setRefundInitiator(async (_b, amount, to) => ({ initiated: true, stub: true, amount: amount.toString(), to }));
    const r = await withdrawStake(BUILDER, STAKE);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('refund_unavailable_stub');
    expect(debitRows().length).toBe(0); // NOTHING written
    expect(await getRealStake(BUILDER)).toBe(STAKE); // still fully backed
  });

  it('refund REFUSED (initiated:false — wrong chain / signer≠escrow) → REFUSED, no debit', async () => {
    __setRefundInitiator(async (_b, amount, to) => ({ initiated: false, stub: false, amount: amount.toString(), to, note: 'signer != escrow' }));
    const r = await withdrawStake(BUILDER, STAKE);
    expect(r.ok).toBe(false);
    expect(debitRows().length).toBe(0);
    expect(await getRealStake(BUILDER)).toBe(STAKE);
  });

  it('refund BROADCAST (real tx hash) → ledger debit written, tagged with that tx hash', async () => {
    const TX = '0x' + 'ab'.repeat(32);
    __setRefundInitiator(async (_b, amount, to) => ({ initiated: true, stub: false, amount: amount.toString(), to, txHash: TX }));
    const r = await withdrawStake(BUILDER, STAKE);
    expect(r.ok).toBe(true);
    expect(r.refund?.txHash).toBe(TX);
    const debits = debitRows();
    expect(debits.length).toBe(1);
    expect(debits[0].amount).toBe((-STAKE).toString());
    expect(debits[0].is_simulated).toBe(false);
    expect(debits[0].deposit_tx_hash).toBe(TX); // the debit is tied to the real refund tx
    expect(await getRealStake(BUILDER)).toBe(0n); // stake fully withdrawn
  });

  it('a SIMULATED stake does not back a REAL withdrawal → REFUSED before any refund', async () => {
    // Inflate total stake with a SIMULATED row (is_simulated=true). getCurrentStake sees
    // 200M, but getRealStake (is_simulated=false only) sees just the 100M real row. A
    // withdrawal of 150M clears the total-stake gate but must fail the real-stake gate —
    // simulated collateral can never be withdrawn as real USDC.
    store().stake_deposits.push({ id: 'dep-sim', builder_id: BUILDER, amount: STAKE.toString(), status: 'active', is_simulated: true, deposit_tx_hash: 'simulated:deposit:x' });
    let refundCalled = false;
    __setRefundInitiator(async (_b, amount, to) => { refundCalled = true; return { initiated: true, stub: false, amount: amount.toString(), to, txHash: '0xshould-not-run' }; });

    const r = await withdrawStake(BUILDER, 150_000_000n); // > realStake (100M), < totalStake (200M)
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/exceeds real/);
    expect(refundCalled).toBe(false); // never even tried to move money
    expect(debitRows().length).toBe(0);
  });

  it('amount > TOTAL stake → REFUSED at the first gate (before the real-stake check)', async () => {
    let refundCalled = false;
    __setRefundInitiator(async (_b, amount, to) => { refundCalled = true; return { initiated: true, stub: false, amount: amount.toString(), to, txHash: '0xno' }; });
    const r = await withdrawStake(BUILDER, STAKE + 1n); // > 100M total
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/exceeds active stake/);
    expect(refundCalled).toBe(false);
    expect(debitRows().length).toBe(0);
  });
});
