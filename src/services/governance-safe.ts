/**
 * FAIL-CLOSED GOVERNOR + RATE LIMITER (CC, 2026-06-25 r6 Phase 3).
 *
 * Ties the session layer, the tamper-evident trace, and a rate limiter into one entry point whose
 * EVERY error path defaults to the SAFE tier (T2 / blocked). Enumerated error paths, each tested:
 *   (a) classifier/session throws            → T2 blocked
 *   (b) trace append/persist fails           → T2 blocked  (can't suppress the log to hide an action)
 *   (c) rate-limit check throws              → T2 blocked
 *   (d) flood detected (T0-spam to bury a T2)→ escalate (every action still classified independently)
 */
import { type Action, type Tier, maxTier } from './consequence-classifier';
import { SessionRiskTracker } from './session-risk';
import { TraceChain } from './governance-trace';

/** Fixed-window rate limiter (time-based). Prevents "flood T0s to bury a T2 / exhaust the gate". */
export class RateLimiter {
  private hits: number[] = [];
  constructor(private readonly maxActions: number, private readonly windowMs: number) {}
  check(now: number): { allowed: boolean; count: number } {
    this.hits = this.hits.filter((t) => t >= now - this.windowMs);
    this.hits.push(now);
    const count = this.hits.length;
    return { allowed: count <= this.maxActions, count };
  }
}

/** Optional durable persist for the trace. If it THROWS, the gate fails closed (action blocked). */
export type TracePersist = (entry: unknown) => void;

export interface SafeVerdict {
  tier: Tier;
  blocked: boolean;
  reason: string;
  rateLimited: boolean;
  traceHash: string | null;
  failClosed: boolean; // true when an error path forced the safe default
}

export interface SafeGovernorOptions {
  rateLimiter?: RateLimiter;
  /** Durable sink; a throw here fails the gate closed (the action cannot proceed unlogged). */
  persist?: TracePersist;
}

export class SafeGovernor {
  readonly session: SessionRiskTracker;
  readonly trace = new TraceChain();
  private readonly rate: RateLimiter;
  private readonly persist?: TracePersist;

  constructor(sessionId: string, opts: SafeGovernorOptions = {}) {
    this.session = new SessionRiskTracker(sessionId);
    this.rate = opts.rateLimiter ?? new RateLimiter(20, 1000); // 20 actions / sec default
    this.persist = opts.persist;
  }

  /** The single fail-closed entry point. Never throws; any failure returns a blocking T2 verdict. */
  govern(action: Action, now: number = Date.now()): SafeVerdict {
    // (c) rate-limit check — a throw here fails closed.
    let rateLimited = false;
    try {
      const r = this.rate.check(now);
      rateLimited = !r.allowed;
    } catch (e) {
      return this.failClosed(`rate-limit check failed: ${msg(e)}`, true, rateLimited);
    }

    // (a) classify + session — a throw here fails closed.
    let tier: Tier;
    let reason: string;
    try {
      const res = this.session.govern(action, { now });
      tier = res.assessment.finalTier;
      reason = res.assessment.reason;
    } catch (e) {
      return this.failClosed(`classifier/session error: ${msg(e)}`, true, rateLimited);
    }

    // (d) flood → escalate to at least chamber (every action is still classified above, so a T2
    // hidden in the flood is already caught; this prevents low-tier spam from exhausting the gate).
    if (rateLimited) {
      tier = maxTier(tier, 'T1');
      reason = `${reason}; RATE-LIMITED flood → escalate to ${tier}`;
    }

    // (b) trace append + persist — a throw here fails closed (cannot proceed unlogged).
    let traceHash: string | null = null;
    try {
      const entry = this.trace.append({ kind: action.kind, tier, reason, rateLimited, ts: now }, now);
      traceHash = entry.hash;
      if (this.persist) this.persist(entry);
    } catch (e) {
      return this.failClosed(`trace write failed (unsuppressable): ${msg(e)}`, true, rateLimited);
    }

    return { tier, blocked: tier === 'T2', reason, rateLimited, traceHash, failClosed: false };
  }

  private failClosed(reason: string, _err: boolean, rateLimited: boolean): SafeVerdict {
    // Best-effort to STILL record the failure (tamper-evident), but never let recording throw out.
    let traceHash: string | null = null;
    try {
      const entry = this.trace.append({ failClosed: true, reason }, Date.now());
      traceHash = entry.hash;
      if (this.persist) try { this.persist(entry); } catch { /* already failing closed */ }
    } catch { /* recording is best-effort on the fail-closed path */ }
    return { tier: 'T2', blocked: true, reason: `FAIL-CLOSED: ${reason}`, rateLimited, traceHash, failClosed: true };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
