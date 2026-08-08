/**
 * local-store.ts — a supabase-js-SHAPED persistent store for LOCAL_MODE.
 *
 * THE POINT: the self-host promise is "your data stays yours". The score path
 * (src/engine/repid-update.ts + its layers) talks to Supabase over the network
 * through the `db` client in src/db.ts. In LOCAL_MODE that `db` resolves to THIS
 * adapter instead — a thin query-builder facade over a LOCAL persistent store, so
 * a full RepID score event completes on the operator's own box with ZERO data
 * egress. Nothing here opens a socket: the only I/O is a local SQLite file (or, if
 * no SQLite driver loads, a local JSON file).
 *
 * SCOPE (honest): this facade implements the SUBSET of the supabase-js query
 * builder that the score path actually uses — enumerated against the live code,
 * not guessed:
 *   repid_agents            .select('*').eq('id',_).single() · .update(_).eq('id',_)
 *                           · .insert(_).select('id').single() (registerAgent)
 *   repid_score_events      .insert(_) · .select('id',{count,head}).eq(_).gte(_)
 *                           · .select(_).eq('agent_id',_)[.in(_).gte(_)]
 *   repid_ecosystem_supply  .select(_).eq('signal_type',_).single()
 *                           · .upsert(_,{onConflict:'signal_type'})
 *   repid_badges            .select('badge_name').eq('agent_id',_) · .insert(_)
 * Methods outside this subset are NOT implemented — a caller that reaches for one
 * gets a loud throw, never a silent wrong answer. This is a self-host store for
 * the score path, not a Supabase reimplementation.
 *
 * PERSISTENCE: rows are held in memory and written THROUGH to a durable backend on
 * every mutation. Backend preference: node:sqlite (real, durable) → a JSON file →
 * pure memory (only for path ':memory:'). Filtering/counting run in JS over a
 * table's rows: correct and simple at single-operator local scale; this is not a
 * query planner.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Row + backend model
// ---------------------------------------------------------------------------

export type Row = Record<string, any>;

interface Backend {
  readonly kind: string;
  load(): Record<string, Row[]>;
  persistTable(table: string, rows: Row[]): void;
  close(): void;
}

/** node:sqlite backend — real, durable, still 100% local (a file on disk). */
function makeSqliteBackend(dbPath: string): Backend | null {
  let DatabaseSync: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null; // driver not available offline → caller falls back
  }
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sdb = new DatabaseSync(dbPath);
  // Generic key/value-of-rows table: one row per (logical table, JSON row). A
  // schemaless store means new score-event columns need no migration.
  sdb.exec(
    'CREATE TABLE IF NOT EXISTS repid_local_store (tbl TEXT NOT NULL, data TEXT NOT NULL)',
  );
  return {
    kind: `node:sqlite(${dbPath})`,
    load() {
      const rows = sdb.prepare('SELECT tbl, data FROM repid_local_store').all() as Array<{
        tbl: string;
        data: string;
      }>;
      const out: Record<string, Row[]> = {};
      for (const r of rows) {
        (out[r.tbl] ??= []).push(JSON.parse(r.data));
      }
      return out;
    },
    persistTable(table: string, rows: Row[]) {
      sdb.exec('BEGIN');
      try {
        sdb.prepare('DELETE FROM repid_local_store WHERE tbl = ?').run(table);
        const ins = sdb.prepare('INSERT INTO repid_local_store (tbl, data) VALUES (?, ?)');
        for (const row of rows) ins.run(table, JSON.stringify(row));
        sdb.exec('COMMIT');
      } catch (e) {
        sdb.exec('ROLLBACK');
        throw e;
      }
    },
    close() {
      sdb.close();
    },
  };
}

/** JSON-file backend — durable fallback when no SQLite driver loads. Local file. */
function makeFileBackend(filePath: string): Backend {
  const resolved = path.resolve(filePath);
  const readAll = (): Record<string, Row[]> => {
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    kind: `file(${resolved})`,
    load: readAll,
    persistTable(table: string, rows: Row[]) {
      const all = readAll();
      all[table] = rows;
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, JSON.stringify(all));
    },
    close() {
      /* nothing to close */
    },
  };
}

/** Pure-memory backend — ONLY for path ':memory:'. Not durable across processes. */
function makeMemoryBackend(): Backend {
  return {
    kind: 'memory',
    load() {
      return {};
    },
    persistTable() {
      /* inert */
    },
    close() {
      /* nothing */
    },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class LocalStore {
  /** Marker for callers/tests to prove `db` is the local adapter, not supabase-js. */
  readonly __localStore = true as const;
  readonly __backend: string;
  private tables: Record<string, Row[]>;

  constructor(private backend: Backend) {
    this.tables = backend.load();
    this.__backend = backend.kind;
  }

  private rowsOf(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  /** Replace a table's rows and write them through to the durable backend. */
  _commit(table: string, rows: Row[]): void {
    this.tables[table] = rows;
    this.backend.persistTable(table, rows);
  }

  _peek(table: string): Row[] {
    return this.rowsOf(table);
  }

  from(table: string): QueryBuilder {
    return new QueryBuilder(this, table);
  }

  close(): void {
    this.backend.close();
  }
}

// ---------------------------------------------------------------------------
// Query builder — a supabase-js-shaped, thenable facade
// ---------------------------------------------------------------------------

type Op = 'select' | 'insert' | 'update' | 'upsert';
type Predicate = (row: Row) => boolean;

interface Result<T = any> {
  data: T;
  error: { message: string; code?: string; details?: string } | null;
  count: number | null;
  status: number;
}

const NO_ROWS_ERROR = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
  details: 'Results contain 0 rows',
};

export class QueryBuilder implements PromiseLike<Result> {
  private op: Op = 'select';
  private predicates: Predicate[] = [];
  private payload: Row[] = [];
  private updatePatch: Row | null = null;
  private onConflict: string | null = null;
  private wantCount = false;
  private headOnly = false;
  private singleRow = false;
  private returning = true; // insert/update return affected rows by default here

  constructor(private store: LocalStore, private table: string) {}

  // --- terminal-verb setters (each returns the builder; execution is on await) ---

  select(_columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    // On a fresh builder this starts a SELECT; on insert/update it marks "return rows".
    if (this.op === 'select') this.op = 'select';
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    this.returning = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.returning = false; // supabase returns null unless .select() is chained
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.updatePatch = patch;
    this.returning = false;
    return this;
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts?.onConflict ?? null;
    this.returning = false;
    return this;
  }

  // --- filters ---

  eq(column: string, value: any): this {
    this.predicates.push((r) => r[column] === value);
    return this;
  }

  gte(column: string, value: any): this {
    this.predicates.push((r) => r[column] !== undefined && r[column] !== null && r[column] >= value);
    return this;
  }

  lte(column: string, value: any): this {
    this.predicates.push((r) => r[column] !== undefined && r[column] !== null && r[column] <= value);
    return this;
  }

  in(column: string, values: any[]): this {
    const set = new Set(values);
    this.predicates.push((r) => set.has(r[column]));
    return this;
  }

  single(): this {
    this.singleRow = true;
    return this;
  }

  maybeSingle(): this {
    this.singleRow = true;
    return this;
  }

  // --- execution ---

  private match(rows: Row[]): Row[] {
    return rows.filter((r) => this.predicates.every((p) => p(r)));
  }

  private run(): Result {
    switch (this.op) {
      case 'select':
        return this.runSelect();
      case 'insert':
        return this.runInsert();
      case 'update':
        return this.runUpdate();
      case 'upsert':
        return this.runUpsert();
      default:
        return { data: null, error: { message: `unsupported op ${this.op}` }, count: null, status: 500 };
    }
  }

  private runSelect(): Result {
    const matched = this.match(this.store._peek(this.table));
    const count = this.wantCount ? matched.length : null;
    if (this.headOnly) {
      return { data: null, error: null, count, status: 200 };
    }
    if (this.singleRow) {
      if (matched.length === 1) {
        return { data: clone(matched[0]!), error: null, count, status: 200 };
      }
      return { data: null, error: { ...NO_ROWS_ERROR }, count, status: 406 };
    }
    return { data: matched.map(clone), error: null, count, status: 200 };
  }

  private runInsert(): Result {
    const rows = this.store._peek(this.table).slice();
    const inserted: Row[] = [];
    for (const raw of this.payload) {
      const row = withDefaults(raw);
      rows.push(row);
      inserted.push(row);
    }
    this.store._commit(this.table, rows);
    return this.affectedResult(inserted);
  }

  private runUpdate(): Result {
    const rows = this.store._peek(this.table).slice();
    const updated: Row[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (this.predicates.every((p) => p(r))) {
        const next = { ...r, ...(this.updatePatch ?? {}) };
        rows[i] = next;
        updated.push(next);
      }
    }
    this.store._commit(this.table, rows);
    return this.affectedResult(updated);
  }

  private runUpsert(): Result {
    if (!this.onConflict) {
      // No conflict target → behaves as insert (matches supabase default of PK conflict,
      // which the score path never relies on — it always passes onConflict).
      return this.runInsert();
    }
    const key = this.onConflict;
    const rows = this.store._peek(this.table).slice();
    const affected: Row[] = [];
    for (const raw of this.payload) {
      const idx = rows.findIndex((r) => r[key] === raw[key]);
      if (idx >= 0) {
        const next = { ...rows[idx]!, ...raw };
        rows[idx] = next;
        affected.push(next);
      } else {
        const row = withDefaults(raw);
        rows.push(row);
        affected.push(row);
      }
    }
    this.store._commit(this.table, rows);
    return this.affectedResult(affected);
  }

  private affectedResult(rows: Row[]): Result {
    if (!this.returning) {
      return { data: null, error: null, count: null, status: 201 };
    }
    if (this.singleRow) {
      return { data: rows.length ? clone(rows[0]!) : null, error: rows.length ? null : { ...NO_ROWS_ERROR }, count: null, status: 201 };
    }
    return { data: rows.map(clone), error: null, count: null, status: 201 };
  }

  // PromiseLike: awaiting the builder executes it. Errors are RETURNED in the
  // result envelope (supabase style), never thrown, so existing `{ data, error }`
  // handling is unchanged.
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let out: Result;
    try {
      out = this.run();
    } catch (e: any) {
      out = { data: null, error: { message: String(e?.message ?? e) }, count: null, status: 500 };
    }
    return Promise.resolve(out).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** Auto-populate id + created_at on insert so downstream reads/ordering work. */
function withDefaults(raw: Row): Row {
  const row = { ...raw };
  if (row.id === undefined || row.id === null) row.id = randomUUID();
  if (row.created_at === undefined) row.created_at = new Date().toISOString();
  return row;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/** Where the durable store lives when the caller doesn't specify. Local, git-ignored. */
export const DEFAULT_LOCAL_STORE_PATH = './.repid-local/store.db';

/**
 * Build a local store. Backend selection is deterministic per path:
 *   ':memory:'  → SQLite in-memory if the driver loads, else pure memory.
 *   <file path> → SQLite file if the driver loads, else a JSON file.
 * Announced LOUDLY once (no silent degradation) so an operator knows exactly what
 * their data-local store is.
 */
export function createLocalStore(storePath?: string): LocalStore {
  const p = storePath || process.env.LOCAL_STORE_PATH || DEFAULT_LOCAL_STORE_PATH;
  let backend = makeSqliteBackend(p);
  if (!backend) {
    backend = p === ':memory:' ? makeMemoryBackend() : makeFileBackend(p);
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[local-store] LOCAL_MODE persistent store = ${backend.kind}. ` +
      `Score events + agent state are written HERE, on this machine — no hosted DB, no data egress.`,
  );
  return new LocalStore(backend);
}
