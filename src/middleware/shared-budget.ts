/**
 * shared-budget.ts — a process-wide spend budget for a KEYLESS route that calls LLM providers.
 *
 * WHY (2026-10-14: public LLM-cost abuse, the money twin of the ReDoS fixes). A per-IP limit bounds one
 * caller; a crowd of rotating IPs stays under every per-IP limit and each of its requests is a paid or
 * quota-limited provider call. This is the ceiling on the crowd: N requests a minute and M a UTC day,
 * across every keyless caller of one route. Spent is FAIL-CLOSED: the caller gets a named refusal
 * (never a pass, never a 500) and the route says so in its own terms. The first refusal in each window
 * is logged at error level, ONCE, so an attack or a launch is visible without a log line per request.
 *
 * In memory, per process, like the routes' own per-IP daily caps (production runs one replica); a
 * restart forgets the counts. ponytail: per-process counts; move to the shared rate-limit store
 * (src/cache/rate-limiter.ts) if the engine ever runs more than one replica.
 */
export type BudgetRefusal = 'global_minute_budget_spent' | 'global_daily_budget_spent';

/** An env knob: 'off' or 0 disables (0), a positive integer is the limit, anything else the default. */
export function budgetLimitFrom(raw: string | undefined, fallback: number): number {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface SharedBudget {
  /** One unit, or why there is none. `perMinute` / `perDay` of 0 means that window is not limited. */
  take(perMinute: number, perDay: number, nowMs?: number): BudgetRefusal | null;
  /** Test seam. */
  reset(): void;
}

export function createSharedBudget(name: string): SharedBudget {
  const s = { minute: -1, minuteCount: 0, day: '', dayCount: 0, logged: new Set<string>() };
  const trip = (reason: BudgetRefusal, windowKey: string, limit: number): BudgetRefusal => {
    if (!s.logged.has(windowKey)) {
      s.logged.add(windowKey);
      console.error(
        `[${name}] SHARED BUDGET SPENT (${reason}): ${limit} keyless requests this ${reason === 'global_daily_budget_spent' ? 'UTC day' : 'minute'}. ` +
          'Every keyless caller is refused until it resets. An attack (rotating IPs) or a launch: check the per-IP spread.',
      );
    }
    return reason;
  };
  return {
    take(perMinute, perDay, nowMs = Date.now()) {
      const minute = Math.floor(nowMs / 60_000);
      const day = new Date(nowMs).toISOString().slice(0, 10);
      if (minute !== s.minute) Object.assign(s, { minute, minuteCount: 0 });
      if (day !== s.day) {
        Object.assign(s, { day, dayCount: 0 });
        s.logged.clear();
      }
      if (perDay > 0 && s.dayCount >= perDay) return trip('global_daily_budget_spent', `d:${day}`, perDay);
      if (perMinute > 0 && s.minuteCount >= perMinute) return trip('global_minute_budget_spent', `m:${minute}`, perMinute);
      s.minuteCount++;
      s.dayCount++;
      return null;
    },
    reset() {
      Object.assign(s, { minute: -1, minuteCount: 0, day: '', dayCount: 0 });
      s.logged.clear();
    },
  };
}
