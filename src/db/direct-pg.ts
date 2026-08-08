/**
 * Direct Postgres client (PostgREST bypass) — CC Sprint 2026-05-21.
 *
 * High-frequency internal calls (agent heartbeat, getNextTask, claim, worker
 * polls) route here instead of through supabase-js / PostgREST. Direct Postgres
 * returns in microseconds even when the REST gateway / Supavisor upstream is
 * saturated and returning `upstream request timeout`. supabase-js stays in
 * place for auth, edge functions, and low-frequency calls.
 *
 * CLAUDE-RULE-8 (NEVER UNBOUNDED WAIT) is baked into pgQuery itself:
 *   - per-attempt hard ceiling via Promise.race + setTimeout-reject (supabase-js
 *     and pg both can hang on a degraded upstream; this releases the caller)
 *   - exponential backoff between attempts (1/4/16/64/256s)
 *   - process-wide circuit breaker: after N consecutive fully-failed calls the
 *     breaker opens for a cool-down so we stop hammering a dead upstream
 *
 * Failure-counting semantics mirror proof-drain-service.ts / ConstitutionalAgentV4
 * (per-operation, NOT per-attempt): a single call that exhausts its retries counts
 * as ONE consecutive failure; any success resets the counter. Hot-path callers
 * pass { retries: 1 } to fail fast (preserving the prior single-withTimeout
 * latency profile) and lean on their own method-level circuit breakers.
 *
 * Connection: DATABASE_URL must be the Supavisor TRANSACTION pooler URL
 * (port 6543), e.g.
 *   postgresql://postgres.<ref>:<pw>@aws-0-us-west-1.pooler.supabase.com:6543/postgres
 * Pool max=5 (one service's runLoop; won't exhaust the pooler). Only one-shot
 * parameterized queries are issued (no named prepared statements / LISTEN /
 * session SET), so transaction-mode pooling is safe.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { publishHealth, deriveBreakerState } from '../resilience/health-bus';
import { assertLocalDataStore } from '../selfhost/egress-guard';

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const POOL_MAX = 5;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const BACKOFF_SCHEDULE_MS = [1000, 4000, 16_000, 64_000, 256_000];

let pool: Pool | null = null;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let circuitOpenLogged = false;

// --- Resilience surface signal (B1) ---------------------------------------------------------------
// The DB endpoint name for the health-bus. Derived from the pooler host:port so a deployment with a
// non-default pooler still publishes a meaningful endpoint. Computed lazily / never throws.
let dbEndpointCached: string | null = null;
function dbEndpoint(): string {
  if (dbEndpointCached) return dbEndpointCached;
  const cs = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
  try {
    const u = new URL(cs);
    dbEndpointCached = `pooler:${u.port || '5432'}`;
  } catch {
    dbEndpointCached = 'pooler:6543';
  }
  return dbEndpointCached;
}

function publishDbHealth(latencyMs: number, ok: boolean, err?: string): void {
  // Never let observability break a query path.
  try {
    const open = Date.now() < circuitOpenUntil;
    publishHealth({
      surface: 'db',
      endpoint: dbEndpoint(),
      healthy: ok && !open,
      state: deriveBreakerState(consecutiveFailures, circuitOpenUntil, CIRCUIT_BREAKER_THRESHOLD),
      latencyMsEwma: latencyMs,
      errorRate: ok ? 0 : 1,
      lastSuccessAt: ok ? Date.now() : undefined,
      lastError: err,
    });
  } catch {
    /* ignore */
  }
}

function resolveConnectionString(): string {
  const cs = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!cs) {
    // Fail loud: no silent fallback to supabase-js. A misconfig must surface at
    // boot (pgPing) or first call, not degrade invisibly.
    throw new Error(
      '[direct-pg] DATABASE_URL (or SUPABASE_DB_URL) is not set. ' +
        'Set the Supabase transaction-pooler connection string (port 6543).'
    );
  }
  return cs;
}

export function getPgPool(): Pool {
  if (!pool) {
    const connectionString = resolveConnectionString();
    // DATA-LOCALITY BOUNDARY (ONLY_ATTESTATIONS_LEAVE): direct-pg opens a raw TCP
    // socket to DATABASE_URL, which the fetch-level guard cannot see. Postgres
    // holds every row (content), so a NON-local host is refused when the boundary
    // is engaged — the node stays provably data-local even if DATABASE_URL is
    // misconfigured to a remote pooler. No-op when the boundary is off (hosted
    // behavior unchanged) or the host is local/private.
    assertLocalDataStore(connectionString, 'DATABASE_URL');
    pool = new Pool({
      connectionString,
      max: POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: DEFAULT_QUERY_TIMEOUT_MS,
      query_timeout: DEFAULT_QUERY_TIMEOUT_MS,
    });
    // A pool 'error' event fires for idle-client errors (e.g. pooler dropped the
    // connection). Log, never crash the process — the next query reconnects.
    pool.on('error', (err) => {
      console.error('[direct-pg] idle pool client error:', err.message);
    });
  }
  return pool;
}

function timeoutReject<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`[direct-pg] query timeout after ${ms}ms: ${label}`)), ms)
  );
}

/**
 * Run a parameterized query and return rows. Throws on failure (after retries)
 * or when the circuit is open. Mirrors the supabase-js return convention by
 * giving callers the rows array directly.
 *
 * @param text   SQL with $1,$2,... placeholders
 * @param params bound parameters
 * @param opts   timeoutMs (default 10s), retries (default 5; hot-path callers pass 1)
 */
export async function pgQuery<T extends QueryResultRow = any>(
  text: string,
  params: any[] = [],
  opts: { timeoutMs?: number; retries?: number; label?: string } = {}
): Promise<T[]> {
  if (Date.now() < circuitOpenUntil) {
    throw new Error(`[direct-pg] circuit open until ${new Date(circuitOpenUntil).toISOString()}`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.retries ?? BACKOFF_SCHEDULE_MS.length);
  const label = opts.label ?? text.slice(0, 48).replace(/\s+/g, ' ');
  const callStart = Date.now();

  // 2026-07-31 — CONFIG ERRORS ARE NOT TRANSIENT, and retrying one is fatal in a
  // way that hides itself. resolveConnectionString() throws when DATABASE_URL /
  // SUPABASE_DB_URL is unset; that throw used to be caught by the retry loop
  // below, which then slept on an `unref()`'d timer. With no pool ever created
  // there are NO handles left holding the event loop, so Node empties it and the
  // PROCESS EXITS 0 MID-RETRY — no error, no log, no stack, exit code 0.
  //
  // That is the root cause of the proof-drain stall: 40,546 jobs pending since
  // 2026-06-16 while the worker reported "Online" and the prover was healthy
  // (verified 2026-07-31). resolveConnectionString's own comment already demanded
  // this behaviour — "must surface at boot (pgPing) or first call, not degrade
  // invisibly" — and the retry loop was silently overriding it. Fail fast, fail
  // loud, and always before any unref()'d sleep can swallow the process.
  //
  // getPgPool() is memoized, so this costs nothing on the happy path.
  try {
    getPgPool();
  } catch (cfgErr) {
    const msg = cfgErr instanceof Error ? cfgErr.message : String(cfgErr);
    console.error(`[direct-pg] FATAL CONFIG ERROR (not retryable) for ${label}: ${msg}`);
    throw cfgErr instanceof Error ? cfgErr : new Error(msg);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let timer: NodeJS.Timeout | null = null;
    try {
      const queryPromise = getPgPool().query<T>(text, params);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[direct-pg] query timeout after ${timeoutMs}ms: ${label}`)), timeoutMs);
      });

      const result = await Promise.race([queryPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      // Success — reset the breaker.
      consecutiveFailures = 0;
      circuitOpenLogged = false;
      publishDbHealth(Date.now() - callStart, true);
      return result.rows;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        const delay = BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!;
        // 2026-07-31 — DO NOT unref() THIS TIMER. It used to be unref'd, which
        // meant that whenever the retry sleep was the only thing left on the
        // event loop, Node considered the process idle and EXITED 0 mid-retry:
        // the caller's await never resumed, the final throw below never ran, and
        // the failure produced no error, no log, and no stack.
        //
        // That is not hypothetical — it is how a bad DATABASE_URL kills this
        // process, and the schedule here is [1s, 4s, 16s, 64s, 256s], so the
        // silent-death window is up to ~5.7 minutes wide. A ref'd timer costs at
        // most that much delay on shutdown (and hot-path callers pass
        // { retries: 1 }, so they never sleep here at all); a silent exit costs
        // an entire pipeline, which is exactly what happened to the proof drain.
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All attempts for THIS call failed → count one consecutive failure.
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitOpenLogged) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    circuitOpenLogged = true;
    console.error(
      `[direct-pg] CIRCUIT OPEN — ${CIRCUIT_BREAKER_THRESHOLD}+ consecutive failed calls; ` +
        `cool-down ${CIRCUIT_COOLDOWN_MS}ms (5min). Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }
  publishDbHealth(Date.now() - callStart, false, lastErr instanceof Error ? lastErr.message : String(lastErr));
  throw lastErr instanceof Error ? lastErr : new Error(`[direct-pg] query failed: ${label}`);
}

/** True while the process-wide breaker is open (B1 degrade trigger). Exported for the wrappers/tests. */
export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

// ==================================================================================================
// B1 — read-cache + write-behind queue (degrade, don't die).
// These are OPT-IN: plain pgQuery() above is byte-for-byte unchanged, so default behavior is identical.
// ==================================================================================================

interface CacheEntry<T> {
  rows: T[];
  storedAt: number;
}

/** Result of a cached read — `stale:true` means it was served from cache because live read failed. */
export interface CachedResult<T> {
  rows: T[];
  stale: boolean;
  /** epoch ms the cached value was stored (only meaningful when stale) */
  cachedAt?: number;
}

const READ_CACHE_MAX = Number(process.env.PG_READ_CACHE_MAX) || 500;
const readCache = new Map<string, CacheEntry<any>>();

function cacheKey(text: string, params: any[], explicit?: string): string {
  return explicit ?? `${text}::${JSON.stringify(params)}`;
}

/** LRU touch: delete+set moves the key to the end (most-recently-used). */
function touchCache<T>(key: string, entry: CacheEntry<T>): void {
  readCache.delete(key);
  readCache.set(key, entry);
  while (readCache.size > READ_CACHE_MAX) {
    const oldest = readCache.keys().next().value;
    if (oldest === undefined) break;
    readCache.delete(oldest);
  }
}

/**
 * Read with last-known-good fallback. On a healthy read, the rows are cached and returned fresh.
 * When the breaker is open OR the live read throws, the last cached value (if any, within ttlMs) is
 * served with `stale:true` — degrade, don't die. If there is no usable cache, the error propagates
 * (RULE-8: fail loud, never silently return empty).
 *
 * @param opts.ttlMs  max age a cached value may be served on failure (default 5 min)
 * @param opts.key    explicit cache key (default = text+params)
 */
export async function pgQueryCached<T extends QueryResultRow = any>(
  text: string,
  params: any[] = [],
  opts: { ttlMs?: number; key?: string; timeoutMs?: number; retries?: number; label?: string } = {}
): Promise<CachedResult<T>> {
  const ttlMs = opts.ttlMs ?? CIRCUIT_COOLDOWN_MS;
  const key = cacheKey(text, params, opts.key);

  const serveStale = (): CachedResult<T> | null => {
    const cached = readCache.get(key) as CacheEntry<T> | undefined;
    if (cached && Date.now() - cached.storedAt <= ttlMs) {
      touchCache(key, cached);
      console.warn(`[direct-pg] serving STALE cache for ${opts.label ?? key.slice(0, 48)} (age ${Date.now() - cached.storedAt}ms)`);
      return { rows: cached.rows, stale: true, cachedAt: cached.storedAt };
    }
    return null;
  };

  // Breaker open → skip the live call entirely, serve cache if we have it.
  if (isCircuitOpen()) {
    const stale = serveStale();
    if (stale) return stale;
    throw new Error(`[direct-pg] circuit open and no usable cache for ${opts.label ?? key.slice(0, 48)}`);
  }

  try {
    const rows = await pgQuery<T>(text, params, opts);
    touchCache(key, { rows, storedAt: Date.now() });
    return { rows, stale: false };
  } catch (err) {
    const stale = serveStale();
    if (stale) return stale;
    throw err;
  }
}

// --- write-behind queue ---------------------------------------------------------------------------
interface PendingWrite {
  text: string;
  params: any[];
  label: string;
  enqueuedAt: number;
}

const WRITE_BEHIND_MAX = Number(process.env.PG_WRITE_BEHIND_MAX) || 1000;
const writeBehindQueue: PendingWrite[] = [];

/** Number of writes currently queued (test/observability). */
export function writeBehindDepth(): number {
  return writeBehindQueue.length;
}

/**
 * Durable-ish write: when the breaker is open, enqueue the write to a bounded in-memory queue and
 * return `{ queued:true }` instead of throwing — the caller's flow continues, the write is replayed on
 * recovery (pgFlushWriteBehind, invoked on pgPing success). When the queue is full we drop the OLDEST
 * with a LOUD log (never silently lose the newest write). When the breaker is closed the write executes
 * immediately like a normal pgQuery.
 *
 * Use ONLY for fire-and-forget writes that tolerate replay-on-recovery (heartbeats, audit logs,
 * counters). Do NOT use for reads or for writes whose result the caller needs synchronously.
 */
export async function pgWriteBehind(
  text: string,
  params: any[] = [],
  opts: { label?: string; timeoutMs?: number; retries?: number } = {}
): Promise<{ executed: boolean; queued: boolean }> {
  const label = opts.label ?? text.slice(0, 48).replace(/\s+/g, ' ');

  if (isCircuitOpen()) {
    if (writeBehindQueue.length >= WRITE_BEHIND_MAX) {
      const dropped = writeBehindQueue.shift();
      console.error(
        `[direct-pg] write-behind queue FULL (${WRITE_BEHIND_MAX}) — dropped OLDEST write ` +
          `(${dropped?.label}) to enqueue ${label}. A write was lost to back-pressure.`
      );
    }
    writeBehindQueue.push({ text, params, label, enqueuedAt: Date.now() });
    console.warn(`[direct-pg] breaker open — write-behind ENQUEUED ${label} (depth ${writeBehindQueue.length})`);
    return { executed: false, queued: true };
  }

  // Breaker closed: execute now (fail-fast — single attempt, no long backoff, since the queue is the
  // back-pressure mechanism). If it fails, enqueue rather than lose it.
  try {
    await pgQuery(text, params, { retries: 1, ...opts });
    return { executed: true, queued: false };
  } catch (err) {
    if (writeBehindQueue.length >= WRITE_BEHIND_MAX) {
      const dropped = writeBehindQueue.shift();
      console.error(`[direct-pg] write-behind queue FULL — dropped OLDEST (${dropped?.label}) for ${label}`);
    }
    writeBehindQueue.push({ text, params, label, enqueuedAt: Date.now() });
    console.warn(`[direct-pg] write failed, ENQUEUED for replay: ${label} (depth ${writeBehindQueue.length})`);
    return { executed: false, queued: true };
  }
}

/**
 * Replay queued writes in FIFO order. Stops at the first failure (leaves the rest queued for the next
 * recovery). Returns the count successfully flushed. Called automatically by pgPing on recovery; can
 * also be invoked by a recovery worker.
 */
export async function pgFlushWriteBehind(): Promise<{ flushed: number; remaining: number }> {
  let flushed = 0;
  while (writeBehindQueue.length > 0) {
    if (isCircuitOpen()) break;
    const next = writeBehindQueue[0]!;
    try {
      await pgQuery(next.text, next.params, { label: next.label, retries: 1 });
      writeBehindQueue.shift();
      flushed += 1;
    } catch (err) {
      console.warn(`[direct-pg] write-behind replay failed for ${next.label}, will retry next recovery`);
      break;
    }
  }
  if (flushed > 0) {
    console.log(`[direct-pg] write-behind flushed ${flushed} write(s); ${writeBehindQueue.length} remaining`);
  }
  return { flushed, remaining: writeBehindQueue.length };
}

/** Test-only: reset cache + queue. */
export function __resetDbResilience(): void {
  readCache.clear();
  writeBehindQueue.length = 0;
}

/** Boot-time reachability check. Single attempt, 5s ceiling. Never throws. */
export async function pgPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await pgQuery('SELECT 1', [], { timeoutMs: 5_000, retries: 1, label: 'pgPing' });
    // Recovery hook: drain any write-behind backlog now that the DB answered. Best-effort, never throws.
    void pgFlushWriteBehind().catch((e) =>
      console.warn('[direct-pg] pgPing flush error:', e instanceof Error ? e.message : String(e))
    );
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Close the pool (graceful shutdown). */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
