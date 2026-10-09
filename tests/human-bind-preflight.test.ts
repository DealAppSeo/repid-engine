/**
 * GET /api/v1/human/bind/preflight — the public, credential-free "what will claiming
 * THIS agent take, and what state is it in" read, answered BEFORE the first wallet
 * prompt. It mints no credential and takes none; every field is already public
 * elsewhere (owner wallet via /agents/:id/owner, RepID via /repid/*). These pins lock
 * the honesty: it never softens the cost (two signatures + the agent's key), it keeps
 * PROVEN ownership apart from a LINKED-but-unsigned account, and a failed DB read is a
 * 503 NOT_CHECKED, never a guessed "unclaimed".
 *
 * HUMAN_AGENT_BIND_ENABLED is read at module load, so byok is require()d after it is set.
 */

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'HUMAN_AGENT_BIND_ENABLED'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.HUMAN_AGENT_BIND_ENABLED = 'true'; // exercise the claimable path
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__PF_STORE__;
});

jest.mock('../src/db', () => {
  const store: Record<string, any[]> = { repid_agents: [], human_agent_bindings: [] };
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
    is(col: string, val: any) { this._filters.push((r) => (r[col] ?? null) === val); return this; }
    limit(n: number) { this._limit = n; return this; }
    order() { return this; } range() { return this; } not() { return this; }
    gte() { return this; } lte() { return this; } gt() { return this; } lt() { return this; }
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
  (globalThis as any).__PF_STORE__ = store;
  return { db };
});

import express from 'express';
import request from 'supertest';

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__PF_STORE__;

let app: express.Express;
// Real agents are uuids. The old fixture used "agent-1", which is exactly the
// unrealistic shape that HID the slug-vs-uuid bug this suite now pins: a non-uuid id
// never exercised the uuid column the route casts into, so a slug (which the public
// surface accepts) crashed on .eq('id', slug) and leaked a 503 in production.
const AGENT = '11111111-1111-4111-8111-111111111111';
// An agent addressed by slug — the way GET /repid/:id and GET /agents/:id/owner also
// allow. Its real id is the uuid below; the slug must resolve TO that uuid.
const SLUG_AGENT_ID = '22222222-2222-4222-8222-222222222222';
const SLUG = 'trinity-shofet';
const OWNER_WALLET = '0x' + 'a'.repeat(40);

function reset() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
}
function seedAgent(builderId: string | null = null) {
  store().repid_agents.push({ id: AGENT, agent_name: 'Sophia', current_repid: 1299, tier: 'ESTABLISHED', builder_id: builderId });
}
function seedBinding(wallet = OWNER_WALLET) {
  store().human_agent_bindings.push({
    id: 'bind-1', agent_id: AGENT, owner_kind: 'builder', builder_id: 'builder-1',
    human_token_id: null, human_wallet: wallet, scope: 'ownership', bound_at: '2026-10-08T00:00:00Z', revoked_at: null,
  });
}
function seedSlugAgent(builderId: string | null = null) {
  store().repid_agents.push({ id: SLUG_AGENT_ID, agent_name: SLUG, current_repid: 777, tier: 'EARNING', builder_id: builderId });
}
function seedSlugBinding(wallet = OWNER_WALLET) {
  store().human_agent_bindings.push({
    id: 'bind-slug', agent_id: SLUG_AGENT_ID, owner_kind: 'builder', builder_id: 'builder-9',
    human_token_id: null, human_wallet: wallet, scope: 'ownership', bound_at: '2026-10-08T00:00:00Z', revoked_at: null,
  });
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const byokRouter = require('../src/routes/v1/byok').default;
  /* eslint-enable @typescript-eslint/no-var-requires */
  app = express();
  app.use(express.json());
  app.use('/api/v1', byokRouter);
});
beforeEach(() => reset());

const preflight = (q: Record<string, string>) =>
  request(app).get('/api/v1/human/bind/preflight').query(q);

describe('GET /human/bind/preflight — expectations set before the first signature', () => {
  it('requires agent_id', async () => {
    const r = await preflight({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
  });

  it('agent does not exist → exists:false, not claimable, honest reason', async () => {
    const r = await preflight({ agent_id: 'nope' });
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(false);
    expect(r.body.claimable).toBe(false);
    expect(r.body.reason).toBe('agent_not_found');
    expect(r.body.agent).toBeNull();
  });

  it('unowned + bind enabled → claimable, with the FULL cost named (never softened)', async () => {
    seedAgent(null);
    const r = await preflight({ agent_id: AGENT });
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(true);
    expect(r.body.claimable).toBe(true);
    expect(r.body.reason).toBe('claimable');
    expect(r.body.ownership.state).toBe('UNOWNED');
    // what you are claiming, from public standing
    expect(r.body.agent).toEqual({ name: 'Sophia', repid: 1299, tier: 'ESTABLISHED' });
    // the cost, stated up front — two prompts, the agent key, no email/name
    expect(r.body.requires.wallet_signatures).toBe(2);
    expect(r.body.requires.agent_key).toBe(true);
    expect(r.body.requires.asks_for_email_or_name).toBe(false);
    expect(r.body.requires.instant).toBe(true);
    expect(typeof r.body.next).toBe('string');
    expect(r.body.next).toMatch(/two wallet signatures/i);
  });

  it('linked to an account but nobody signed → LINKED_NOT_OWNED, still claimable (linked ≠ owned)', async () => {
    seedAgent('builder-7'); // administratively linked, no binding row
    const r = await preflight({ agent_id: AGENT });
    expect(r.body.ownership.state).toBe('LINKED_NOT_OWNED');
    expect(r.body.ownership.linked_account).toBe('builder-7');
    expect(r.body.ownership.owned_by_you).toBe(false);
    expect(r.body.claimable).toBe(true);
  });

  it('already owned by someone else → OWNED, not claimable, owner wallet shown (it is public)', async () => {
    seedAgent('builder-1');
    seedBinding(OWNER_WALLET);
    const r = await preflight({ agent_id: AGENT });
    expect(r.body.ownership.state).toBe('OWNED');
    expect(String(r.body.ownership.owner_wallet).toLowerCase()).toBe(OWNER_WALLET);
    expect(r.body.ownership.owned_by_you).toBe(false); // no wallet supplied
    expect(r.body.claimable).toBe(false);
    expect(r.body.reason).toBe('already_owned');
  });

  it('owned by YOU (wallet query matches) → owned_by_you:true, "nothing to claim"', async () => {
    seedAgent('builder-1');
    seedBinding(OWNER_WALLET);
    const r = await preflight({ agent_id: AGENT, wallet: OWNER_WALLET.toUpperCase() });
    expect(r.body.ownership.owned_by_you).toBe(true);
    expect(r.body.claimable).toBe(false);
    expect(r.body.next).toMatch(/already own/i);
  });

  it('a GENUINE DB read failure (not a malformed id) is 503 NOT_CHECKED, and leaks no raw error', async () => {
    // A well-formed uuid whose read returns a real DB error — the one case that is
    // honestly "could not check". Distinct from a bad id, which is agent_not_found below.
    const s = store();
    const orig = (s.repid_agents as any);
    // Replace the array with a proxy whose filter throws — the route reads via db.from().
    // Simpler: monkeypatch the mocked db.from to throw once for repid_agents.
    const dbMod = require('../src/db');
    const realFrom = dbMod.db.from;
    let thrown = false;
    dbMod.db.from = (t: string) => {
      if (t === 'repid_agents' && !thrown) {
        thrown = true;
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) };
      }
      return realFrom(t);
    };
    try {
      const r = await preflight({ agent_id: AGENT });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('not_checked');
      // The raw DB error string is logged server-side, never returned to the client.
      expect(JSON.stringify(r.body)).not.toContain('boom');
    } finally {
      dbMod.db.from = realFrom;
      void orig;
    }
  });

  // ── slug resolution — the bug this change fixes (prod commit 62fb06a) ──────────
  // repid_agents.id is a uuid. The public surface addresses agents by slug too
  // (GET /repid/trinity-sophia works), so preflight must resolve a slug instead of
  // casting it into the uuid id column and 503-ing with a leaked postgres error.

  it('resolves a human-readable slug to the agent, instead of crashing on the uuid cast', async () => {
    seedSlugAgent(null);
    const r = await preflight({ agent_id: SLUG });
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(true);
    // resolved to the real row — not bounced as a 503 uuid-cast error
    expect(r.body.agent).toEqual({ name: SLUG, repid: 777, tier: 'EARNING' });
    expect(r.body.claimable).toBe(true);
    expect(r.body.reason).toBe('claimable');
  });

  it('slug lookup is case-insensitive (mirrors the .ilike in GET /agents/by-name)', async () => {
    seedSlugAgent(null);
    const r = await preflight({ agent_id: SLUG.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(true);
    expect(r.body.agent.name).toBe(SLUG);
  });

  it('reads ownership against the RESOLVED uuid, not the slug (OWNED survives a slug lookup)', async () => {
    seedSlugAgent('builder-9');
    seedSlugBinding(OWNER_WALLET);
    const r = await preflight({ agent_id: SLUG });
    // If ownerOfAgent/linkedButUnbound had been handed the slug, the binding — keyed by
    // the uuid — would have been missed and this would read UNOWNED. OWNED proves the
    // resolved uuid was passed through.
    expect(r.body.ownership.state).toBe('OWNED');
    expect(String(r.body.ownership.owner_wallet).toLowerCase()).toBe(OWNER_WALLET);
    expect(r.body.claimable).toBe(false);
    expect(r.body.reason).toBe('already_owned');
  });

  it('an unknown slug is agent_not_found (200), NOT 503 not_checked — bad input is not "could not check"', async () => {
    const r = await preflight({ agent_id: 'trinity-nobody-home' });
    expect(r.status).toBe(200);
    expect(r.status).not.toBe(503);
    expect(r.body.exists).toBe(false);
    expect(r.body.reason).toBe('agent_not_found');
    expect(r.body.agent).toBeNull();
    // and it never echoes a raw postgres uuid-cast error
    expect(JSON.stringify(r.body)).not.toMatch(/invalid input syntax|type uuid/i);
  });
});
