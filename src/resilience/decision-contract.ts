/**
 * decision-contract.ts — the STABLE interface between GA's ANFIS failover brain and CC's
 * resilience wrappers (SPRINT_GA_ANFIS_FAILOVER_BRAIN.md §4 / SPRINT_CC_EGRESS_AND_RESILIENCE.md).
 *
 * CC imports the TYPES + `decideFailover` from this module and obeys the guarantees below. CC does
 * NOT import (or need to know about) the ANFIS math — that lives privately in `./anfis-failover.ts`
 * (patent hard-stop: the coefficient matrices never leave the private module / never appear in docs).
 *
 * GOVERNING PRINCIPLE: shadow-first, flagged, fail-safe. A failover brain that ACTS on a bad signal
 * is worse than no brain, so the contract guarantees the wrapper can always fall back to the static
 * order: on low confidence, on error, and whenever the per-surface enable flag is OFF (the default).
 *
 * --- CONTRACT GUARANTEES (what a wrapper can rely on) ----------------------------------------
 *  1. DETERMINISTIC for identical input — no hidden randomness (testable).
 *  2. FAIL-SAFE default — if the brain throws OR returns confidence < RESILIENCE_MIN_CONFIDENCE
 *     (default 0.6), the wrapper MUST treat the decision as `use_primary` then the static fallback
 *     order. `decideFailover` itself NEVER throws to the caller (it catches and returns a safe
 *     `use_primary` decision with `confidence:0, shadow:true`).
 *  3. SHADOW FLAG IS AUTHORITATIVE — when a surface's enable flag is OFF (default for all 8),
 *     `decision.shadow === true`; the wrapper IGNORES `action` but SHOULD log the decision. The
 *     wrapper acts on `action` ONLY when that surface's enable flag is ON (Phase 7).
 *  4. CONSERVATISM SCALES WITH STAKES — higher `requestStakes` biases toward `use_primary`/known-good
 *     and demands higher confidence before recommending a failover (a high-value request is never
 *     the guinea pig for an unproven standby).
 *  5. OBSERVABLE — the brain's only side effect is a swallowed, awaited shadow log to
 *     `anfis_routing_logs` (see `./shadow-log.ts`); it never mutates RepID, money, or on-chain state.
 */

export type Surface =
  | 'compute'
  | 'llm'
  | 'db_read'
  | 'db_write'
  | 'rpc'
  | 'payments'
  | 'deploy'
  | 'liveness';

/** All eight resilience surfaces, in canonical order. */
export const SURFACES: readonly Surface[] = [
  'compute',
  'llm',
  'db_read',
  'db_write',
  'rpc',
  'payments',
  'deploy',
  'liveness',
] as const;

/** Live state of one failover target (primary or a fallback), as the wrapper observes it. */
export interface TargetState {
  /** e.g. 'railway', 'fly-sjc', 'groq', 'pooler:6543', 'rpc-url-1' */
  target: string;
  /** breaker state from a health.ts-style primitive */
  healthy: boolean;
  consecutiveErrors: number;
  latencyMsP50: number | null;
  /** 0–1 over a recent window */
  errorRate: number;
  /** surface-normalized: USDC/call, $/GB-hr, gas est, … */
  costPerUnit: number;
  /** 0–1, from anfis_provider_performance_lookup hit_rate (or a bootstrap prior) */
  reliability: number;
  /** epoch ms of last success, or null if never */
  lastSuccessAt: number | null;
}

/** What the wrapper hands the brain for one decision. */
export interface SurfaceSignal {
  surface: Surface;
  /** current primary target name */
  primary: string;
  /** primary + ordered fallbacks, each with live state */
  candidates: TargetState[];
  /** 0–1 normalized request value/urgency (drives conservatism) */
  requestStakes: number;
  /** optional task/category hint */
  requestHint?: string;
}

export type FailoverAction =
  /** primary is fine — use it */
  | 'use_primary'
  /** switch to chosenTarget (a named fallback) */
  | 'failover'
  /** RPC-style: advance to next endpoint */
  | 'rotate'
  /** open breaker, serve degraded (cache/queue/local-verify) */
  | 'trip_breaker'
  /** serve last-known-good / enqueue / local floor */
  | 'degrade';

/** What the brain returns. */
export interface FailoverDecision {
  surface: Surface;
  action: FailoverAction;
  /** the target the wrapper should use now */
  chosenTarget: string;
  /** 0–1 */
  confidence: number;
  /** human-readable, logged */
  reason: string;
  /** LASSO interpretability — which features drove the decision */
  selectedFeatures: string[];
  /** true = advisory only (wrapper ignores `action`, logs it) */
  shadow: boolean;
}

/**
 * Minimum confidence below which a wrapper MUST fall back to static order (guarantee 2).
 * Read at call-time so it is tunable/reversible via env without redeploy of callers.
 */
export const RESILIENCE_MIN_CONFIDENCE = (): number => {
  const v = Number(process.env.RESILIENCE_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.6;
};

/**
 * Is a surface's shadow flag ON? Shadow is ON by default for every surface — the brain only LOGS
 * decisions until a surface is explicitly enabled. `RESILIENCE_ANFIS_SHADOW_<SURFACE>=false`
 * combined with `RESILIENCE_ANFIS_ENABLE_<SURFACE>=true` is what lets a surface actuate.
 */
export const isSurfaceShadow = (surface: Surface): boolean => {
  const key = `RESILIENCE_ANFIS_SHADOW_${surface.toUpperCase()}`;
  return process.env[key] !== 'false';
};

/**
 * Is a surface ENABLED to actuate? Default OFF for ALL eight surfaces (Phase 7). Flipping one is a
 * separate, loud, reversible Sean action AFTER the A/B harness shows PROMOTE for that surface.
 */
export const isSurfaceEnabled = (surface: Surface): boolean => {
  const key = `RESILIENCE_ANFIS_ENABLE_${surface.toUpperCase()}`;
  return process.env[key] === 'true';
};

/**
 * A decision is in shadow (advisory only) unless the surface is BOTH enabled AND not forced-shadow.
 * This is the single source of truth for guarantee 3 — the brain and the wrapper agree on it.
 */
export const decisionIsShadow = (surface: Surface): boolean =>
  !isSurfaceEnabled(surface) || isSurfaceShadow(surface);

// The implementation lives in ./anfis-failover (private — keeps coefficient matrices out of this
// contract surface). Re-exported here so CC imports a single module.
export { decideFailover } from './anfis-failover';
