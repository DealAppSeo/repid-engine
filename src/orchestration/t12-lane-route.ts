/**
 * t12-lane-route.ts — which free host a lane may ask, and what happens when one refuses.
 *
 * A 429 still stops that wave, for the reason t12Wave records: cascading through providers on every
 * rate limit is what produced the 2026-09 bursts. What changes is what the 429 leaves behind: a
 * durable cooldown for that one host. The task is released without cost, and its next claim routes
 * to a host that is not cooling. So a provider sees at most one failed call per cooldown window,
 * however many tasks and lanes are running, and the cost of a limit is one call, not a retry storm.
 *
 * Failover inside one ask is bounded by MAX_HOSTS_PER_ASK and covers non-429 failures only.
 *
 * Measured 2026-11-08 by one call per route. Each route below answered, and each is free by
 * something checkable: OpenRouter's catalog prices the model at 0 and the request caps price at 0,
 * so a paid model is refused rather than billed. NIM runs on developer credits; Groq and Cerebras
 * on their free plans, which no API confirms. Routes outside T12_ROUTES cannot be reached from here.
 *
 * LiteLLM is deliberately not a lane route. Its gateway answers `auto` for free today, but it also
 * serves paid names, retries inside the pool, and hides which vendor was called, so a cooldown here
 * could neither see nor stop what it did.
 */
import { t12Ask, t12Target, type T12AskResult, type T12RouteAttempt } from './t12-attempt';
import { t12FreeWaveEnabled, t12LocalBase, T12_LOCAL_HOST } from './t12-free-wave';
import { coolProvider, coolingProviders, recordRouteAttempt, type Handle, type TxDb } from './t12-lane-store';

/** Least-contended first: all twelve fleet agents share the Groq key, so it goes last. */
export const T12_LANE_ROUTE_ORDER = ['nvidia', 'openrouter', 'cerebras', 'groq'] as const;
export const MAX_HOSTS_PER_ASK = 2;

export const COOLDOWN_SECONDS = {
  /** A 429 with no Retry-After. */
  rateLimited: 15 * 60,
  /** Key or model refused. Not transient, so do not ask again tonight. */
  misconfigured: 6 * 60 * 60,
  /** Timeouts, 5xx, empty answers. */
  transient: 2 * 60,
};

const MISCONFIGURED = new Set([401, 402, 403, 404, 410]);

/** How long this attempt keeps its host out of rotation, or null when it should not. */
export function cooldownFor(a: Pick<T12RouteAttempt, 'status' | 'reason' | 'retryAfterMs'>): number | null {
  if (a.reason === 'answered' || a.reason === 'no_credentials' || a.reason === 'egress_refused') return null;
  if (a.status === 429) return a.retryAfterMs === undefined ? COOLDOWN_SECONDS.rateLimited : Math.max(1, Math.ceil(a.retryAfterMs / 1000));
  if (a.status !== null && MISCONFIGURED.has(a.status)) return COOLDOWN_SECONDS.misconfigured;
  return COOLDOWN_SECONDS.transient;
}

export type RoutedAnswer =
  | T12AskResult
  | { outcome: 'no_capacity'; host: null; tried: string[]; text: null; until: string; reason: string };

type Env = Record<string, string | undefined>;

export function createRoutedAsk(
  db: TxDb,
  options: { env?: Env; fetchImpl?: Parameters<typeof t12Ask>[1] extends infer O ? (O extends { fetchImpl?: infer F } ? F : never) : never; timeoutMs?: number } = {},
): (prompt: string, h: Handle) => Promise<RoutedAnswer> {
  const env = options.env ?? process.env;
  return async (prompt, h) => {
    if (!t12FreeWaveEnabled(env)) return { outcome: 'NOT_CHECKED', host: null, tried: [], text: null };
    const order = [...(t12LocalBase(env) ? [T12_LOCAL_HOST] : []), ...T12_LANE_ROUTE_ORDER].filter((host) => t12Target(host, env));
    if (order.length === 0) return { outcome: 'NOT_CHECKED', host: null, tried: [], text: null };

    const cooling = await coolingProviders(db);
    const open = order.filter((host) => !cooling.has(host));
    if (open.length === 0) {
      const until = [...cooling.values()].sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
      return { outcome: 'no_capacity', host: null, tried: [], text: null, until, reason: `all ${order.length} free routes are cooling` };
    }

    return t12Ask(prompt, {
      env,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      order: open.slice(0, MAX_HOSTS_PER_ASK),
      onAttempt: async (a) => {
        const seconds = cooldownFor(a);
        const until = seconds === null ? null : await coolProvider(db, a.host, seconds, a.reason);
        await recordRouteAttempt(db, h, a, until);
      },
    });
  };
}
