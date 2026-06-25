/**
 * SPEND TRACKER (CC, 2026-06-24 r5) — closes cost-splitting at the ROOT.
 *
 * A single sub-threshold spend ($0.99 < $1 cap) is legitimately T1 — blocking every one of
 * them would be over-blocking (XC round-5 Class-7 false positive). The real attack is SPLITTING:
 * many sub-threshold spends in rapid succession that sum past the cap or fire too fast. That can
 * only be caught with STATE — a rolling window of cumulative spend + velocity.
 *
 * This module holds that state. `classifyAction` stays pure; callers that govern spends keep a
 * SpendTracker and pass its current window snapshot into the classifier, which escalates to T2
 * when adding this spend would breach the cumulative cap OR the velocity limit.
 */

export interface SpendWindowSnapshot {
  /** Total USD already spent inside the rolling window (excluding the action being classified). */
  windowTotalUsd: number;
  /** Count of spends already inside the rolling window (excluding the action being classified). */
  windowCount: number;
}

export interface SpendTrackerConfig {
  /** Rolling window length in ms (default 60s). */
  windowMs: number;
  /** Cumulative USD across the window at/above which the next spend is T2. */
  cumulativeCapUsd: number;
  /** Number of spends in the window at/above which the next spend is T2 (velocity). */
  velocityLimit: number;
}

export const DEFAULT_SPEND_TRACKER_CONFIG: SpendTrackerConfig = {
  windowMs: 60_000,
  cumulativeCapUsd: 2.0,
  velocityLimit: 3,
};

interface SpendEvent {
  ts: number;
  costUsd: number;
}

export class SpendTracker {
  private events: SpendEvent[] = [];
  private readonly cfg: SpendTrackerConfig;

  constructor(cfg: Partial<SpendTrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_SPEND_TRACKER_CONFIG, ...cfg };
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    this.events = this.events.filter((e) => e.ts >= cutoff);
  }

  /** Snapshot of the window BEFORE the action being classified (what classifyAction consumes). */
  snapshot(now: number = Date.now()): SpendWindowSnapshot {
    this.prune(now);
    return {
      windowTotalUsd: this.events.reduce((s, e) => s + e.costUsd, 0),
      windowCount: this.events.length,
    };
  }

  /** Record a spend that actually happened (call AFTER the gate permits it). */
  record(costUsd: number, now: number = Date.now()): void {
    this.prune(now);
    this.events.push({ ts: now, costUsd: Math.max(0, costUsd) });
  }

  config(): SpendTrackerConfig {
    return this.cfg;
  }
}

/**
 * Pure decision: would ADDING this spend to the current window breach the cap or velocity?
 * Returns the reason string if so, else null. Used by the classifier.
 */
export function spendBreachesWindow(
  costUsd: number,
  snap: SpendWindowSnapshot,
  cfg: SpendTrackerConfig = DEFAULT_SPEND_TRACKER_CONFIG,
): string | null {
  const projectedTotal = snap.windowTotalUsd + Math.max(0, costUsd);
  const projectedCount = snap.windowCount + 1;
  if (projectedTotal >= cfg.cumulativeCapUsd) {
    return `cumulative spend $${projectedTotal.toFixed(2)} ≥ cap $${cfg.cumulativeCapUsd} in ${cfg.windowMs}ms window (splitting)`;
  }
  if (projectedCount >= cfg.velocityLimit) {
    return `spend velocity ${projectedCount} ≥ ${cfg.velocityLimit} in ${cfg.windowMs}ms window (splitting)`;
  }
  return null;
}
