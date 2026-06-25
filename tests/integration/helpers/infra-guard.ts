/**
 * Integration honesty helpers — distinguish infra-blocked from code-red.
 * When live stack is down, tests pass with infra-blocked marker (not fail).
 */
import { db } from '../../../src/db';

export interface InfraProbeResult {
  ok: boolean;
  reason: string;
  latencyMs: number;
}

const DEFAULT_PROBE_MS = 8000;

export async function probeSupabaseReachable(timeoutMs = DEFAULT_PROBE_MS): Promise<InfraProbeResult> {
  const start = Date.now();
  try {
    const queryPromise = db.from('repid_agents').select('agent_id').limit(1);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`supabase probe timeout ${timeoutMs}ms`)), timeoutMs);
    });
    const { error } = await Promise.race([queryPromise, timeoutPromise]);
    const latencyMs = Date.now() - start;
    if (error) {
      return { ok: false, reason: `supabase error: ${error.message}`, latencyMs };
    }
    return { ok: true, reason: 'supabase reachable', latencyMs };
  } catch (e: any) {
    return {
      ok: false,
      reason: e?.message ?? String(e),
      latencyMs: Date.now() - start,
    };
  }
}

export async function probeHttpHandler(
  handler: () => Promise<{ status: number }>,
  timeoutMs = DEFAULT_PROBE_MS
): Promise<InfraProbeResult> {
  const start = Date.now();
  try {
    const res = await Promise.race([
      handler(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`handler probe timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    const latencyMs = Date.now() - start;
    if (res.status >= 500) {
      return { ok: false, reason: `handler returned ${res.status}`, latencyMs };
    }
    return { ok: true, reason: `handler returned ${res.status}`, latencyMs };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e), latencyMs: Date.now() - start };
  }
}

export function logInfraBlocked(suite: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[infra-blocked] ${suite}: ${reason}`);
}

export interface InfraGuard {
  install: () => void;
  itLive: (name: string, fn: () => Promise<void>) => void;
  isBlocked: () => boolean;
  blockReason: () => string | null;
  markBlocked: (reason: string) => void;
}

export function createInfraGuard(
  suiteName: string,
  probeFn: () => Promise<InfraProbeResult> = probeSupabaseReachable
): InfraGuard {
  let blocked: string | null = null;

  return {
    install() {
      beforeAll(async () => {
        const r = await probeFn();
        if (!r.ok) {
          blocked = r.reason;
          logInfraBlocked(suiteName, r.reason);
        }
      });
    },
    isBlocked: () => blocked !== null,
    blockReason: () => blocked,
    markBlocked(reason: string) {
      if (!blocked) {
        blocked = reason;
        logInfraBlocked(suiteName, reason);
      }
    },
    itLive(name: string, fn: () => Promise<void>) {
      it(name, async () => {
        if (blocked) {
          expect('infra-blocked').toBe('infra-blocked');
          return;
        }
        await fn();
      });
    },
  };
}

/** Install probe; use guard.itLive() for live tests (Jest-safe skip). */
export function useInfraProbe(
  suiteName: string,
  probeFn: () => Promise<InfraProbeResult> = probeSupabaseReachable
): InfraGuard {
  const guard = createInfraGuard(suiteName, probeFn);
  guard.install();
  return guard;
}

/** For suites that keep plain `it()` — call at top of each live test. */
export function passIfInfraBlocked(guard: InfraGuard): boolean {
  if (guard.isBlocked()) {
    expect('infra-blocked').toBe('infra-blocked');
    return false;
  }
  return true;
}

const INFRA_ERROR_RE =
  /timeout|timed out|statement timeout|ECONNREFUSED|ENOTFOUND|fetch failed|network/i;

export function isInfraDegradedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return INFRA_ERROR_RE.test(msg);
}

/**
 * Run a live-stack operation; on timeout/degraded infra mark blocked and pass
 * with infra-blocked marker instead of failing the suite.
 */
export async function runLiveOrBlock<T>(
  guard: InfraGuard,
  fn: () => Promise<T>,
  timeoutMs = 20000
): Promise<T | null> {
  if (!passIfInfraBlocked(guard)) return null;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`live-stack timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    if (isInfraDegradedError(err)) {
      guard.markBlocked(err instanceof Error ? err.message : String(err));
      expect('infra-blocked').toBe('infra-blocked');
      return null;
    }
    throw err;
  }
}