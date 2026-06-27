/**
 * types.ts — the common `Resilient<T>` contract every CC-owned surface wrapper implements
 * (SPRINT_CC_EGRESS_AND_RESILIENCE.md Half B / B0).
 *
 * GA's ANFIS failover brain (src/resilience/decision-contract.ts, merged #110) decides WHEN failover
 * fires; THIS file defines the uniform shape CC's wrappers expose so the brain can drive all of them the
 * same way:
 *   - every wrapper PUBLISHES `SurfaceHealth` to the in-process health-bus (read at GET /api/v1/resilience/health)
 *   - every wrapper ACCEPTS a `RoutingDecision` (the ANFIS preference, pushed via POST /api/v1/resilience/route)
 *
 * GOVERNING PRINCIPLE (shared with the decision-contract): degrade, don't die. A wrapper always has a
 * static fallback order it can fall back to, and ANFIS can never route to an endpoint the wrapper has
 * marked hard-down (wrapper health is the safety floor — see B5).
 *
 * NOTE: this is the CC-facing companion to GA's `decision-contract.ts`. The two are intentionally
 * distinct: `decision-contract.ts` is the brain's IN/OUT shape (SurfaceSignal -> FailoverDecision);
 * THIS file is the wrapper's observability/intake shape (SurfaceHealth + RoutingDecision). The B5 intake
 * route translates between them.
 */

/** Breaker state, mirroring the closed/open/half-open vocabulary of the existing primitives. */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** One snapshot a wrapper publishes per (surface, endpoint) to the health-bus. */
export interface SurfaceHealth {
  /** 'db' | 'rpc' | 'llm' | 'x402' (the four CC-owned surfaces) */
  surface: string;
  /** concrete target: 'pooler:6543', 'https://sepolia.base.org', 'groq', 'x402.org' */
  endpoint: string;
  healthy: boolean;
  state: BreakerState;
  /** exponential-weighted moving average of call latency in ms */
  latencyMsEwma: number;
  /** 0–1 over a recent window */
  errorRate: number;
  /** epoch ms of last success, omitted if never */
  lastSuccessAt?: number;
  /** last error message, omitted if none */
  lastError?: string;
}

/**
 * What ANFIS pushes IN per surface (the wrapper-facing routing preference). This is the simplified,
 * actuation-time view the wrapper reads at call time; the full brain output is `FailoverDecision` in
 * decision-contract.ts, which the B5 intake route maps onto this shape.
 */
export interface RoutingDecision {
  /** ANFIS-preferred endpoint for this surface; wrapper honors it iff it is not hard-down */
  preferredEndpoint?: string;
  /** force the wrapper off its primary onto the fallback order */
  forceFallback?: boolean;
  /** open the breaker until this epoch-ms (ANFIS-driven proactive trip) */
  tripUntil?: number;
}

/** The uniform interface each surface wrapper implements. */
export interface ResilientSurface<Req, Res> {
  /** Run one request. `decision` (when provided + the surface is enabled) biases endpoint choice. */
  run(req: Req, decision?: RoutingDecision): Promise<Res>;
  /** Current per-endpoint health snapshots for this surface. */
  health(): SurfaceHealth[];
}
