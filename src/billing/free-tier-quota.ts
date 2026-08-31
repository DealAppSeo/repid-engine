/**
 * free-tier-quota.ts — free-tier daily call-quota tracking (backlog item 9's second half,
 * reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * `checkCap`/`incrementSpend` (./caps.ts) already gate providers on MONTHLY $ SPEND, wired live
 * into `src/providers/router.ts`'s hot path (`checkCap` is called on every candidate adapter).
 * But every provider in `FREE_PROVIDERS` (./free-providers.ts) bills close to $0 per call by
 * definition, so a $-denominated cap structurally can never trip for them no matter how many
 * calls they take — that system exists and is real, it just cannot see free-tier usage. The gap
 * backlog item 9 names is narrower than "no cap system exists": it is "no CALL-COUNT ceiling
 * exists for providers whose cost signal is always ~zero."
 *
 * This module is that missing piece: a pure decision layer (no I/O, no DB read) that takes a
 * caller-supplied call count for a provider today and a daily cap, and decides whether another
 * call is allowed. Deliberately NOT wired into `router.ts`'s `capHit` path or any live call
 * counter this beat — where the count is actually tracked (a new column vs. counting
 * `llm_call_log` rows live), whether it plugs into `router.ts`'s existing `cap_hit` reason or a
 * distinct one, and the fail-open-vs-closed choice when the count is unavailable are all
 * follow-up decisions, not squeezed into this beat's turn budget.
 */

export interface FreeTierQuotaInput {
  provider: string;
  /** Calls already made to this provider today, however the caller chooses to track it. */
  callsToday: number;
  /** Daily call ceiling. `<= 0` means uncapped — this is opt-in, not a silent default deny. */
  dailyCallCap: number;
}

export interface FreeTierQuotaDecision {
  allowed: boolean;
  remaining: number;
  reason: string;
}

export function evaluateFreeTierQuota(input: FreeTierQuotaInput): FreeTierQuotaDecision {
  const { provider, callsToday, dailyCallCap } = input;

  if (dailyCallCap <= 0) {
    return {
      allowed: true,
      remaining: Infinity,
      reason: `${provider}: no daily call cap configured`,
    };
  }

  if (callsToday >= dailyCallCap) {
    return {
      allowed: false,
      remaining: 0,
      reason: `${provider}: daily free-tier quota (${dailyCallCap}) reached — ${callsToday} calls today`,
    };
  }

  return {
    allowed: true,
    remaining: dailyCallCap - callsToday,
    reason: `${provider}: ${dailyCallCap - callsToday} of ${dailyCallCap} daily calls remaining`,
  };
}
