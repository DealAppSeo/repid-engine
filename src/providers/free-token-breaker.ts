/**
 * free-token-breaker.ts — a loop that is meant to run on FREE tokens can never spend money.
 *
 * Overnight plan 2026-11-01, item 0 ("required before any long loop" / "build first, no paid
 * fallback"). For future T12 loops on free open-source tokens.
 *
 * STATUS: STUB. INERT. Nothing imports this yet — no router, dispatcher or loop calls it, so it
 * changes no request today. A loop opts in by calling `admit()` before each LLM call and
 * `record()` after it, and stopping on anything other than ALLOW. Wiring it into a loop is a
 * separate change; until then this file proves the rule, not that any loop obeys it.
 *
 * THE RULES
 *  - Free means an EXPLICIT zero price for that exact (provider, model) in billing/pricing.ts
 *    (`costClass`). A provider-level free-tier label (`FREE_PROVIDERS`) is not enough: it cannot
 *    say which model, and an unpriced model may well be billing us.
 *  - 'paid' → DENY. 'unpriced', or a missing/invalid input → NOT_CHECKED. Neither is ALLOW.
 *  - There is NO fallback. Free-tier exhaustion (N quota refusals in a row, across providers)
 *    halts the loop; it never reroutes to a paid model. No verdict carries a "try this instead".
 *  - The receipt outranks the label: a recorded call that billed cost_usd > 0 halts, even if the
 *    price table said free.
 *  - It LATCHES. Once tripped, every later admit/record returns the original trip (same decision,
 *    same reason) until the loop builds a new breaker — i.e. a human restarts it.
 *
 * Distinct from trustshell's `CircuitBreaker` (src/lib/circuit-breaker.ts), which halts on N
 * identical failures. That one stops a stuck loop; this one stops a loop that would spend.
 */

import { costClass } from './cost-class';

export type BreakerVerdict =
  | { decision: 'ALLOW' }
  | { decision: 'DENY'; reason: string }
  | { decision: 'NOT_CHECKED'; reason: string };

export interface FreeCallOutcome {
  provider: string;
  model: string;
  /** 'quota' = the provider refused for rate/quota (e.g. HTTP 429). */
  status: 'ok' | 'quota' | 'error';
  /** What the call actually cost, from the call's own ledger row. Required. */
  cost_usd: number;
}

export interface FreeTokenBreakerOptions {
  /** Hard cap on recorded calls for one loop. Default 500. */
  maxCalls?: number;
  /** Consecutive quota refusals (any provider) before halting. Default 3. */
  maxConsecutiveQuota?: number;
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new Error(`FreeTokenBreaker ${name} must be an integer >= 1, got ${v}`);
  return v;
}

export class FreeTokenBreaker {
  private readonly maxCalls: number;
  private readonly maxConsecutiveQuota: number;
  private calls = 0;
  private quotaStreak = 0;
  private trip: Exclude<BreakerVerdict, { decision: 'ALLOW' }> | null = null;

  constructor(opts: FreeTokenBreakerOptions = {}) {
    this.maxCalls = positiveInt('maxCalls', opts.maxCalls ?? 500);
    this.maxConsecutiveQuota = positiveInt('maxConsecutiveQuota', opts.maxConsecutiveQuota ?? 3);
  }

  /** The verdict the breaker tripped on, or null if it has not tripped. */
  get tripped(): Exclude<BreakerVerdict, { decision: 'ALLOW' }> | null {
    return this.trip;
  }

  /** Call BEFORE each LLM call. Anything but ALLOW means: do not make the call, stop the loop. */
  admit(provider: string, model: string): BreakerVerdict {
    if (this.trip) return this.trip;
    return this.checkPrice(provider, model) ?? { decision: 'ALLOW' };
  }

  /** Call AFTER each LLM call with what actually happened. Anything but ALLOW means: stop. */
  record(outcome: FreeCallOutcome): BreakerVerdict {
    if (this.trip) return this.trip;
    const priced = this.checkPrice(outcome?.provider, outcome?.model);
    if (priced) return priced;

    const cost = outcome.cost_usd;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      return this.halt('NOT_CHECKED', `free_breaker: cost_usd missing or invalid (${String(cost)}) — cannot confirm the call was free`);
    }
    if (cost > 0) {
      return this.halt('DENY', `free_breaker: ${outcome.provider}/${outcome.model} billed $${cost} — a free loop spent money`);
    }

    this.calls++;
    this.quotaStreak = outcome.status === 'quota' ? this.quotaStreak + 1 : 0;
    if (this.quotaStreak >= this.maxConsecutiveQuota) {
      return this.halt('DENY', `free_breaker: ${this.quotaStreak} quota refusals in a row — free tier exhausted, halting (no paid fallback)`);
    }
    if (this.calls >= this.maxCalls) {
      return this.halt('DENY', `free_breaker: call cap ${this.maxCalls} reached`);
    }
    return { decision: 'ALLOW' };
  }

  private checkPrice(provider: string | undefined, model: string | undefined): BreakerVerdict | null {
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
      return this.halt('NOT_CHECKED', 'free_breaker: provider or model missing — cannot price the call');
    }
    const cls = costClass(provider, model);
    if (cls === 'free') return null;
    if (cls === 'paid') return this.halt('DENY', `free_breaker: ${provider}/${model} is paid — refused, no paid fallback`);
    return this.halt('NOT_CHECKED', `free_breaker: ${provider}/${model} is unpriced — unknown is not free`);
  }

  private halt(decision: 'DENY' | 'NOT_CHECKED', reason: string): BreakerVerdict {
    const trip = { decision, reason };
    this.trip = trip;
    return trip;
  }
}
