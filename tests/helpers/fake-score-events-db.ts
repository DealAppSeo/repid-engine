/**
 * A tiny in-memory stand-in for the supabase-js query builder that APPLIES its filters.
 *
 * Most existing db mocks return a canned array whatever the query asks for, so they cannot tell a
 * reader that filters `is_shadow = false` from one that does not. This one actually evaluates
 * eq / neq / in / gte / gt / lte / lt / not-is-null / is / contains / order / limit, so a test seeds a
 * shadow row beside the real rows and asserts on the reader's answer.
 *
 * `repid_score_events.is_shadow` is NOT NULL DEFAULT false in prod; a seeded row without the key is
 * therefore read as false, as the database would.
 */
export type FakeTables = Record<string, Array<Record<string, any>>>;

type Pred = (r: Record<string, any>) => boolean;

class Q implements PromiseLike<any> {
  private preds: Pred[] = [];
  private head = false;
  private wantCount = false;
  private one: 'single' | 'maybe' | null = null;
  private lim: number | null = null;
  private ord: Array<{ col: string; asc: boolean }> = [];
  private op: 'select' | 'insert' | 'upsert' | 'update' = 'select';
  private payload: any = null;

  constructor(private tables: FakeTables, private table: string) {}

  private view(r: Record<string, any>) {
    return this.table === 'repid_score_events' && r.is_shadow == null ? { ...r, is_shadow: false } : r;
  }
  private add(p: Pred) { this.preds.push((r) => p(this.view(r))); return this; }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(rows: any) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows: any) { this.op = 'upsert'; this.payload = rows; return this; }
  update(patch: any) { this.op = 'update'; this.payload = patch; return this; }
  eq(c: string, v: any) { return this.add((r) => r[c] === v); }
  neq(c: string, v: any) { return this.add((r) => r[c] !== v); }
  in(c: string, vs: any[]) { return this.add((r) => vs.includes(r[c])); }
  gte(c: string, v: any) { return this.add((r) => r[c] != null && r[c] >= v); }
  gt(c: string, v: any) { return this.add((r) => r[c] != null && r[c] > v); }
  lte(c: string, v: any) { return this.add((r) => r[c] != null && r[c] <= v); }
  lt(c: string, v: any) { return this.add((r) => r[c] != null && r[c] < v); }
  is(c: string, v: any) { return this.add((r) => (v === null ? r[c] == null : r[c] === v)); }
  not(c: string, op: string, v: any) {
    return this.add((r) => (op === 'is' && v === null ? r[c] != null : r[c] !== v));
  }
  contains(c: string, obj: Record<string, any>) {
    return this.add((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v));
  }
  order(col: string, o?: { ascending?: boolean }) { this.ord.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }

  private run() {
    const rows = (this.tables[this.table] ??= []);
    if (this.op === 'insert' || this.op === 'upsert') {
      const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows.push(...arr.map((r: any) => ({ ...r })));
      return { data: this.one ? { id: 1 } : null, error: null, count: null };
    }
    if (this.op === 'update') return { data: null, error: null, count: null };
    let out = rows.filter((r) => this.preds.every((p) => p(r)));
    const count = this.wantCount ? out.length : null;
    for (const { col, asc } of [...this.ord].reverse()) {
      out = [...out].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1)));
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    if (this.head) return { data: null, error: null, count };
    if (this.one === 'single') {
      return out.length === 1
        ? { data: out[0], error: null, count }
        : { data: null, error: { code: 'PGRST116', message: 'no or multiple rows' }, count };
    }
    if (this.one === 'maybe') return { data: out[0] ?? null, error: null, count };
    return { data: out, error: null, count };
  }

  then<T1 = any, T2 = never>(
    ok?: ((v: any) => T1 | PromiseLike<T1>) | null,
    bad?: ((e: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

export function makeFakeDb(tables: FakeTables) {
  return {
    from: (t: string) => new Q(tables, t),
    rpc: async () => ({ data: null, error: null }),
  };
}

/** The fixture every test below shares: a real row and a settlement-shadow-like row (NONZERO delta). */
export const NOW = () => new Date().toISOString();
export function realRow(over: Record<string, any> = {}) {
  return { agent_id: 'a1', event_type: 'SERVICE_SATISFIED', delta: 5, repid_before: 100, repid_after: 105, repid_delta_applied: 5, is_shadow: false, created_at: NOW(), metadata: {}, ...over };
}
export function shadowRow(over: Record<string, any> = {}) {
  // What trg_settlement_shadow_emit writes: a nonzero `delta` that was never applied.
  return { agent_id: 'a1', event_type: 'SERVICE_SATISFIED', delta: 30, repid_before: 105, repid_after: 105, repid_delta_applied: 0, is_shadow: true, created_at: NOW(), metadata: { mode: 'SHADOW_NO_MUTATION' }, ...over };
}
