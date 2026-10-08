/**
 * TRUE E2E — the full trust chain, in one deterministic test, no live DB and no live chain:
 *
 *     human binds an agent  (bindOwnerToAgent, two-sided bind)
 *       -> that human's builder stakes  (depositStake, simulated path)
 *         -> the agent does an agent-to-agent service transaction  (applyServiceSatisfiedDeltas)
 *           -> and THAT transaction moves the agent's RepID score  (repid_score_events + repid_agents)
 *
 * The headline assertion is the last arrow: a bound, staked agent's `current_repid`
 * changes by a known, deterministic delta BECAUSE a counterparty settled a service
 * contract with it. Everything up-stream is exercised against the SAME in-memory store,
 * so the agent whose score moves is provably the one the human bound and staked behind.
 *
 * WHY THESE EXACT NUMBERS (fixed under default env):
 *   SERVICE_SATISFIED at satisfaction 0.8 → provider round(30*0.8)=+24, buyer round(15*0.8)=+12
 *   (src/services/validation-repid-delta.ts SERVICE_SATISFIED_DELTA_BASE = {provider:30, buyer:15}).
 *   Both agents start at 1000 → provider 1024, buyer 1012. No decay (REPID_DECAY_MODE off),
 *   writer applies in-process (WRITER_DIRECT_APPLY default true), contract is NOT simulated.
 *
 * The real path, not a hypothesis: the a2a value-transfer that moves RepID synchronously is the
 * service-contract cascade (applyValidationEvent, src/scoring/pipeline.ts), NOT the x402 tip flow
 * (which writes repid_events async) and NOT the FIXED_DELTAS updateRepId engine (no a2a caller).
 */

// --- env MUST be set before any service/config module loads; services are required
//     in beforeAll so these take effect (config.ts + human-agent-binding.ts both read
//     env at module-load time). Captured and restored in afterAll so these mutations
//     never leak to another suite sharing this jest worker's process.env. ---
const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'HUMAN_AGENT_BIND_ENABLED',
  'REAL_STAKING_ENABLED',
  'WRITER_DIRECT_APPLY',
  'REPID_DECAY_MODE',
  'X402_REAL_RPC',
  'SELF_REPORT_EVIDENCE_MODE',
  'REPID_DELTA_STATEMENT_MODE',
] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
// Default-mode flags: unset so every number is deterministic.
for (const k of [
  'REAL_STAKING_ENABLED',
  'WRITER_DIRECT_APPLY',
  'REPID_DECAY_MODE',
  'X402_REAL_RPC',
  'SELF_REPORT_EVIDENCE_MODE',
  'REPID_DELTA_STATEMENT_MODE',
]) {
  delete process.env[k];
}

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__E2E_STORE__;
});

const OWNER_ADDRESS = '0x' + '1'.repeat(40);

// A compact in-memory Supabase fake. One store, shared across all three legs, so an
// UPDATE in the a2a leg is visible to a later read. Supports only the chain shapes these
// services actually use (select/insert/update + eq/ilike/in/limit/order + single/maybeSingle
// + await). Attached to globalThis so the factory (hoisted, can't close over locals) and the
// test can share it.
jest.mock('../../src/db', () => {
  const store: Record<string, any[]> = {
    builders: [],
    repid_agents: [],
    human_agent_bindings: [],
    stake_deposits: [],
    agent_stakes: [],
    stake_authority_snapshots: [],
    service_contracts: [],
    x402_settlements: [],
    repid_score_events: [],
    repid_proof_queue: [],
    hal_audit_chain: [],
    audit_events: [],
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
    constructor(table: string) {
      this.table = table;
    }
    select(_cols?: string) {
      this._selected = true;
      return this;
    }
    eq(col: string, val: any) {
      this._filters.push((r) => r[col] === val);
      return this;
    }
    ilike(col: string, val: any) {
      const v = String(val).toLowerCase();
      this._filters.push((r) => String(r[col] ?? '').toLowerCase() === v);
      return this;
    }
    in(col: string, vals: any[]) {
      this._filters.push((r) => vals.includes(r[col]));
      return this;
    }
    limit(n: number) {
      this._limit = n;
      return this;
    }
    // Permissive no-op filters so a transitive helper using one of these never throws.
    order() {
      return this;
    }
    range() {
      return this;
    }
    not() {
      return this;
    }
    gte() {
      return this;
    }
    lte() {
      return this;
    }
    gt() {
      return this;
    }
    lt() {
      return this;
    }
    is() {
      return this;
    }
    maybeSingle() {
      this._maybe = true;
      return this;
    }
    single() {
      this._single = true;
      return this;
    }
    insert(payload: any) {
      this._op = 'insert';
      const t = tbl(this.table);
      const rows = Array.isArray(payload) ? payload : [payload];
      const inserted = rows.map((r) => {
        const row = { ...r };
        if (row.id === undefined) row.id = `${this.table}-${t.length + 1}`;
        t.push(row);
        return row;
      });
      this._inserted = Array.isArray(payload) ? inserted : inserted[0];
      return this;
    }
    update(payload: any) {
      this._op = 'update';
      this._payload = payload;
      return this;
    }
    delete() {
      this._op = 'delete';
      return this;
    }
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
      if (this._op === 'update') {
        rows.forEach((r) => Object.assign(r, this._payload));
        return { data: rows, error: null };
      }
      if (this._op === 'delete') {
        for (const r of rows) {
          const i = t.indexOf(r);
          if (i >= 0) t.splice(i, 1);
        }
        return { data: null, error: null };
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      if (this._single) {
        return rows.length
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      }
      if (this._maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null, count: rows.length };
    }
    then(onF?: (v: any) => any, onR?: (e: any) => any) {
      return Promise.resolve(this._exec()).then(onF, onR);
    }
    catch(onR: (e: any) => any) {
      return this.then(undefined, onR);
    }
    finally(fn: () => void) {
      return this.then().finally(fn);
    }
  }

  const db = { from: (table: string) => new Q(table) };
  (globalThis as any).__E2E_STORE__ = store;
  return { db };
});

// Service modules are imported dynamically AFTER env is set (see beforeAll).
let bindOwnerToAgent: typeof import('../../src/services/human-agent-binding').bindOwnerToAgent;
let depositStake: typeof import('../../src/services/stake-vault').depositStake;
let applyServiceSatisfiedDeltas: typeof import('../../src/services/validation-repid-delta').applyServiceSatisfiedDeltas;

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__E2E_STORE__;

function seed() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  s.builders.push({
    id: 'builder-1',
    address: OWNER_ADDRESS,
    current_repid: 6000,
    auth_method: 'token_only',
  });
  s.repid_agents.push(
    {
      id: 'provider-1',
      agent_name: 'PROVIDER',
      current_repid: 1000,
      tier: 'ESTABLISHED',
      activity_30d: 5,
      vesting_cliff_ends_at: null,
      wisdom_score: 1000,
      character_score: 1000,
      last_active_at: null,
      builder_id: 'builder-1',
    },
    {
      id: 'buyer-1',
      agent_name: 'BUYER',
      current_repid: 1000,
      tier: 'ESTABLISHED',
      activity_30d: 5,
      vesting_cliff_ends_at: null,
      wisdom_score: 1000,
      character_score: 1000,
      last_active_at: null,
      builder_id: 'builder-1',
    },
  );
  // A NON-simulated contract: empty metadata/payload, no x402 settlement link.
  s.service_contracts.push({
    id: 'contract-1',
    provider_agent_id: 'provider-1',
    buyer_agent_id: 'buyer-1',
    metadata: {},
    payload: {},
    x402_payment_id: null,
  });
}

beforeAll(() => {
  // require (not dynamic import): synchronous, CommonJS-native under this jest config,
  // and runs AFTER the env above is set so config.ts + human-agent-binding.ts read the
  // right flags at module-load time.
  /* eslint-disable @typescript-eslint/no-var-requires */
  bindOwnerToAgent = require('../../src/services/human-agent-binding').bindOwnerToAgent;
  depositStake = require('../../src/services/stake-vault').depositStake;
  applyServiceSatisfiedDeltas = require('../../src/services/validation-repid-delta').applyServiceSatisfiedDeltas;
  /* eslint-enable @typescript-eslint/no-var-requires */
});

beforeEach(() => seed());

describe('E2E: bind -> stake -> agent-to-agent transaction -> RepID moves', () => {
  it('runs the whole chain and the a2a transaction moves the bound+staked agent\'s RepID', async () => {
    const s = store();

    // LEG 1 — the human binds their agent (trustedCaller skips the wallet+key proofs,
    // which is the documented test/operator path; the bind itself is still exercised).
    const bind = await bindOwnerToAgent({
      owner: { kind: 'builder', id: 'builder-1' },
      agentId: 'provider-1',
      trustedCaller: true,
    });
    expect(bind.ok).toBe(true);
    const bindingRow = s.human_agent_bindings.find((r) => r.agent_id === 'provider-1');
    expect(bindingRow).toBeTruthy();
    expect(bindingRow.owner_kind).toBe('builder');
    expect(bindingRow.builder_id).toBe('builder-1');

    // LEG 2 — the human's builder stakes (simulated path: no real chain, is_simulated true).
    const dep = await depositStake(OWNER_ADDRESS, 100_000_000n);
    expect(dep.ok).toBe(true);
    expect(dep.is_simulated).toBe(true);
    expect(dep.builder_id).toBe('builder-1');
    const stakeRow = s.stake_deposits.find((r) => r.builder_id === 'builder-1');
    expect(stakeRow).toBeTruthy();
    expect(String(stakeRow.deposit_tx_hash)).toMatch(/^simulated:deposit:/);

    // Sanity: nothing so far has moved any RepID (stake and RepID are separate ledgers).
    expect(s.repid_score_events.length).toBe(0);
    expect(s.repid_agents.find((a) => a.id === 'provider-1').current_repid).toBe(1000);

    // LEG 3 — the agent-to-agent transaction: the buyer settles the service contract
    // "satisfied" at 0.8. THIS is the step that moves RepID.
    await applyServiceSatisfiedDeltas(
      { id: 'contract-1', provider_agent_id: 'provider-1', buyer_agent_id: 'buyer-1' },
      0.8,
    );

    // HEADLINE — the transaction moved the score, deterministically.
    const events = s.repid_score_events.filter((e) => e.event_type === 'SERVICE_SATISFIED');
    expect(events.length).toBe(2);

    const providerEvent = events.find((e) => e.agent_id === 'provider-1');
    const buyerEvent = events.find((e) => e.agent_id === 'buyer-1');
    expect(providerEvent).toMatchObject({ delta: 24, repid_before: 1000, repid_after: 1024, repid_delta_applied: 24 });
    expect(buyerEvent).toMatchObject({ delta: 12, repid_before: 1000, repid_after: 1012, repid_delta_applied: 12 });

    // The agent the human bound (provider-1) now carries the moved score in repid_agents.
    expect(s.repid_agents.find((a) => a.id === 'provider-1').current_repid).toBe(1024);
    expect(s.repid_agents.find((a) => a.id === 'buyer-1').current_repid).toBe(1012);

    // The chain is connected: the agent whose RepID moved is the one bound to the builder
    // who staked — not merely some agent that happened to transact.
    expect(bindingRow.agent_id).toBe(providerEvent.agent_id);
    expect(stakeRow.builder_id).toBe(bindingRow.builder_id);
  });

  it('a SIMULATED contract records the a2a event but moves NO RepID (the sim gate)', async () => {
    const s = store();
    // Flip the contract to simulated via the canonical truthy sim flag on metadata
    // (src/utils/truthy.ts hasTruthySimFlag keys on `is_simulated`).
    const contract = s.service_contracts.find((c) => c.id === 'contract-1');
    contract.metadata = { is_simulated: true };

    await applyServiceSatisfiedDeltas(
      { id: 'contract-1', provider_agent_id: 'provider-1', buyer_agent_id: 'buyer-1' },
      0.8,
    );

    // Audit rows still written (honest trail), but delta 0 and no score moved.
    const events = s.repid_score_events.filter((e) => e.event_type === 'SERVICE_SATISFIED');
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.delta).toBe(0);
      expect(e.repid_after).toBe(e.repid_before);
    }
    expect(s.repid_agents.find((a) => a.id === 'provider-1').current_repid).toBe(1000);
    expect(s.repid_agents.find((a) => a.id === 'buyer-1').current_repid).toBe(1000);
  });
});
