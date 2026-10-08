/**
 * A2A scoring ladder E2E — every agent-to-agent touchpoint that moves RepID, proven
 * deterministically against one in-memory store (no live DB, no live chain). Companion
 * to bind-stake-a2a-repid.test.ts (which covers SERVICE_SATISFIED / T2); this covers:
 *
 *   T3 SERVICE_OUTCOME (good/bad), the largest-weight, hardest-to-game touchpoint
 *     good  → provider +60 × rater-weight      bad → provider −80 × rater-weight
 *     rater-weight = clamp(raterRepid/1000, 0.25, 2.0) — a high-rep rater moves more,
 *     a fresh rater still counts a quarter; the BUYER/rater is never scored for rating.
 *   DISPUTE provider_at_fault → provider −100, buyer +20.
 *   The simulation gate on BOTH — a simulated contract records nothing / moves nothing,
 *     so a fake transaction can never buy (or cost) reputation. This is the exact leak
 *     the 2026-05-27 marketplace demo hit (−100 on a simulated contract); it stays closed.
 *
 * Numbers are fixed under default env (REPID_DECAY_MODE off, WRITER_DIRECT_APPLY true).
 */

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'WRITER_DIRECT_APPLY',
  'REPID_DECAY_MODE',
  'SELF_REPORT_EVIDENCE_MODE',
  'REPID_DELTA_STATEMENT_MODE',
] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
for (const k of ['WRITER_DIRECT_APPLY', 'REPID_DECAY_MODE', 'SELF_REPORT_EVIDENCE_MODE', 'REPID_DELTA_STATEMENT_MODE']) {
  delete process.env[k];
}
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__A2A_STORE__;
});

// Compact in-memory Supabase fake — same shape proven in bind-stake-a2a-repid.test.ts.
// Only the chains applyValidationEvent + isContractSimulated use are needed here.
jest.mock('../../src/db', () => {
  const store: Record<string, any[]> = {
    repid_agents: [],
    service_contracts: [],
    x402_settlements: [],
    repid_score_events: [],
    repid_proof_queue: [],
    hal_audit_chain: [],
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
  (globalThis as any).__A2A_STORE__ = store;
  return { db };
});

let applyServiceOutcomeDeltas: typeof import('../../src/services/validation-repid-delta').applyServiceOutcomeDeltas;
let applyServiceDisputeResolution: typeof import('../../src/services/validation-repid-delta').applyServiceDisputeResolution;
let computeRaterWeight: typeof import('../../src/services/validation-repid-delta').computeRaterWeight;

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__A2A_STORE__;

function agent(id: string, repid = 1000) {
  return { id, agent_name: id.toUpperCase(), current_repid: repid, tier: 'ESTABLISHED', activity_30d: 5, vesting_cliff_ends_at: null };
}
function seed(simulated = false) {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  s.repid_agents.push(agent('provider-1'), agent('buyer-1'));
  s.service_contracts.push({
    id: 'contract-1',
    provider_agent_id: 'provider-1',
    buyer_agent_id: 'buyer-1',
    metadata: simulated ? { is_simulated: true } : {},
    payload: {},
    x402_payment_id: null,
  });
}
const repidOf = (id: string) => store().repid_agents.find((a) => a.id === id)!.current_repid;
const eventsFor = (id: string) => store().repid_score_events.filter((e) => e.agent_id === id);

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const m = require('../../src/services/validation-repid-delta');
  applyServiceOutcomeDeltas = m.applyServiceOutcomeDeltas;
  applyServiceDisputeResolution = m.applyServiceDisputeResolution;
  computeRaterWeight = m.computeRaterWeight;
  /* eslint-enable @typescript-eslint/no-var-requires */
});
beforeEach(() => seed());

const contract = { id: 'contract-1', provider_agent_id: 'provider-1', buyer_agent_id: 'buyer-1' };

describe('T3 SERVICE_OUTCOME — rater-weighted, provider-only', () => {
  it('good rating from a baseline (1000) rater: provider +60', async () => {
    const r = await applyServiceOutcomeDeltas(contract, 'good', 1000);
    expect(r.raterWeight).toBe(1);
    expect(r.providerDelta).toBe(60);
    expect(repidOf('provider-1')).toBe(1060);
    expect(repidOf('buyer-1')).toBe(1000); // the rater is never scored for rating
    expect(eventsFor('buyer-1').length).toBe(0);
  });

  it('bad rating: provider −80, and it is dispute-eligible (flag only, no auto-dispute)', async () => {
    const r = await applyServiceOutcomeDeltas(contract, 'bad', 1000);
    expect(r.providerDelta).toBe(-80);
    expect(r.disputeEligible).toBe(true);
    expect(repidOf('provider-1')).toBe(920);
  });

  it('rater-weight scales and clamps: whale rater (2000) → ×2, fresh rater (100) → ×0.25 floor', async () => {
    expect(computeRaterWeight(2000)).toBe(2);
    expect(computeRaterWeight(100)).toBe(0.25);
    await applyServiceOutcomeDeltas(contract, 'good', 2000); // +round(60*2)=+120
    expect(repidOf('provider-1')).toBe(1120);

    seed(); // fresh state
    await applyServiceOutcomeDeltas(contract, 'good', 100); // +round(60*0.25)=+15
    expect(repidOf('provider-1')).toBe(1015);
  });

  it('simulated contract: bad rating moves NOTHING and writes NO event, but still flags dispute-eligible', async () => {
    seed(true); // simulated
    const r = await applyServiceOutcomeDeltas(contract, 'bad', 1000);
    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(r.disputeEligible).toBe(true);
    expect(repidOf('provider-1')).toBe(1000);
    expect(store().repid_score_events.length).toBe(0);
  });
});

describe('DISPUTE resolution — provider_at_fault', () => {
  it('provider −100, buyer +20', async () => {
    await applyServiceDisputeResolution(contract, 'provider_at_fault');
    expect(repidOf('provider-1')).toBe(900);
    expect(repidOf('buyer-1')).toBe(1020);
    // Provider's penalty is recorded as VALIDATION_FAILED, buyer's credit as SERVICE_FULFILLED.
    expect(eventsFor('provider-1')[0].event_type).toBe('VALIDATION_FAILED');
    expect(eventsFor('buyer-1')[0].event_type).toBe('SERVICE_FULFILLED');
  });

  it('simulated contract: dispute moves NOTHING (the 2026-05-27 demo leak stays closed)', async () => {
    seed(true);
    await applyServiceDisputeResolution(contract, 'provider_at_fault');
    expect(repidOf('provider-1')).toBe(1000);
    expect(repidOf('buyer-1')).toBe(1000);
    expect(store().repid_score_events.length).toBe(0);
  });
});
