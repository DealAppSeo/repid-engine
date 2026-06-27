/**
 * health-bus.ts — in-process registry every resilience wrapper publishes `SurfaceHealth` to
 * (SPRINT_CC_EGRESS_AND_RESILIENCE.md B0). Read-only, exposed at GET /api/v1/resilience/health, which
 * is the surface GA's ANFIS sprint ingests.
 *
 * Also holds the latest `RoutingDecision` per surface (the ANFIS preference pushed via
 * POST /api/v1/resilience/route, B5). Pure in-process state — no DB, no I/O, never throws to a caller.
 * A latency EWMA helper is provided so wrappers compute a stable latency signal without each reinventing it.
 */
import type { SurfaceHealth, RoutingDecision, BreakerState } from './types';

/** key = `${surface}::${endpoint}` so multiple endpoints per surface coexist (e.g. 3 RPC URLs). */
const healthMap = new Map<string, SurfaceHealth>();

/** key = surface; the latest ANFIS routing preference for that surface. */
const decisionMap = new Map<string, RoutingDecision>();

/** EWMA smoothing factor — 0.3 weights recent latency without over-reacting to a single spike. */
const EWMA_ALPHA = 0.3;

function key(surface: string, endpoint: string): string {
  return `${surface}::${endpoint}`;
}

/**
 * Publish (upsert) a health snapshot. Wrappers call this on every run. `latencyMsEwma` on the incoming
 * snapshot is treated as the just-observed latency and folded into the stored EWMA; pass the raw
 * per-call latency and the bus maintains the moving average for you.
 */
export function publishHealth(snapshot: SurfaceHealth): void {
  const k = key(snapshot.surface, snapshot.endpoint);
  const prev = healthMap.get(k);
  const observed = Number.isFinite(snapshot.latencyMsEwma) ? snapshot.latencyMsEwma : 0;
  const latencyMsEwma = prev
    ? EWMA_ALPHA * observed + (1 - EWMA_ALPHA) * prev.latencyMsEwma
    : observed;
  healthMap.set(k, { ...snapshot, latencyMsEwma });
}

/** Read all current health snapshots (the GET /resilience/health payload). */
export function getAllHealth(): SurfaceHealth[] {
  return Array.from(healthMap.values());
}

/** Read health snapshots for one surface. */
export function getSurfaceHealth(surface: string): SurfaceHealth[] {
  return Array.from(healthMap.values()).filter((h) => h.surface === surface);
}

/** Is a specific endpoint hard-down (breaker open / unhealthy)? The wrapper-health safety floor (B5). */
export function isEndpointHardDown(surface: string, endpoint: string): boolean {
  const h = healthMap.get(key(surface, endpoint));
  if (!h) return false; // unknown = not yet observed = assume usable
  return !h.healthy || h.state === 'open';
}

/** Store the latest ANFIS routing decision for a surface (POST /resilience/route → here). */
export function setRoutingDecision(surface: string, decision: RoutingDecision): void {
  decisionMap.set(surface, decision);
}

/** Read the latest ANFIS routing decision for a surface, or undefined if none set. */
export function getRoutingDecision(surface: string): RoutingDecision | undefined {
  return decisionMap.get(surface);
}

/** All stored routing decisions (for the GET /resilience/health introspection payload). */
export function getAllRoutingDecisions(): Record<string, RoutingDecision> {
  const out: Record<string, RoutingDecision> = {};
  for (const [k, v] of decisionMap.entries()) out[k] = v;
  return out;
}

/** Test-only: clear all bus state. */
export function __resetHealthBus(): void {
  healthMap.clear();
  decisionMap.clear();
}

/**
 * Small helper a wrapper uses to derive a `BreakerState` from a consecutive-failure count +
 * cooldown clock, matching the existing primitives' semantics (closed → open at threshold,
 * half-open during the probe window after cooldown).
 */
export function deriveBreakerState(
  consecutiveFailures: number,
  openUntil: number,
  threshold: number,
  now: number = Date.now()
): BreakerState {
  if (now < openUntil) return 'open';
  // cooldown elapsed but breaker had tripped → half-open (next call probes)
  if (openUntil > 0 && consecutiveFailures >= threshold) return 'half-open';
  return 'closed';
}
