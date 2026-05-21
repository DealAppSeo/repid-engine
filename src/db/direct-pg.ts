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
    pool = new Pool({
      connectionString: resolveConnectionString(),
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

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await Promise.race<QueryResult<T>>([
        getPgPool().query<T>(text, params),
        timeoutReject<QueryResult<T>>(timeoutMs, label),
      ]);
      // Success — reset the breaker.
      consecutiveFailures = 0;
      circuitOpenLogged = false;
      return result.rows;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        const delay = BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!;
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
  throw lastErr instanceof Error ? lastErr : new Error(`[direct-pg] query failed: ${label}`);
}

/** Boot-time reachability check. Single attempt, 5s ceiling. Never throws. */
export async function pgPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await pgQuery('SELECT 1', [], { timeoutMs: 5_000, retries: 1, label: 'pgPing' });
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
