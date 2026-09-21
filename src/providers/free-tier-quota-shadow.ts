/**
 * free-tier-quota-shadow.ts — Shadow-only wiring for the ANFIS free-tier quota gate
 * (backlog item 9, reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * WHAT THIS IS
 * ------------
 * `evaluateFreeTierQuota` (../billing/free-tier-quota.ts) is a pure decision layer that needs
 * a caller-supplied call count and daily cap. `getFreeProviderCallsToday`
 * (../billing/free-provider-call-count.ts) resolves the count by querying `llm_call_log`.
 * Both are built and tested with zero callers.
 *
 * This module wires them together in the only honest way for now: a SHADOW-ONLY logger that
 * observes what would have been blocked under a configurable daily call cap, without blocking
 * anything. It is a measurement step, not a behavior change.
 *
 * GATING
 * ------
 * Completely inert unless `FREE_TIER_QUOTA_SHADOW_ENABLED=true`. Fire-and-forget async —
 * a DB error or shadow failure must never break routing. Called AFTER `router.ts` returns
 * its result, so routing is byte-identical to today when the gate is off.
 *
 * DEFAULTS (decisions (b)/(c) from backlog item 9)
 * -------------------------------------------------
 * (b) Daily call cap: 500 calls per 24h per provider. Override: `FREE_TIER_DAILY_CAP_DEFAULT`.
 *     A cap <= 0 means uncapped; the primitive's own opt-in-uncapped behaviour applies.
 * (c) Signal name: `free_quota_hit` — distinct from the $-denominated `cap_hit` routing reason.
 *
 * SHADOW-FIRST INVARIANT
 * ----------------------
 * This module NEVER blocks a provider call. It logs what WOULD have been blocked. Switching
 * from shadow to enforce requires a deliberate wiring change in `router.ts`, not an env flip.
 */

import { getFreeProviderCallsToday } from '../billing/free-provider-call-count';
import { evaluateFreeTierQuota } from '../billing/free-tier-quota';

const DEFAULT_DAILY_CAP = 500;

/**
 * Observe whether `provider` would have hit its daily free-tier call cap, and log if so.
 * Returns null when the gate is off or the provider would be allowed.
 * Never throws — a DB error or any failure is caught and warned.
 */
export async function shadowFreeTierQuota(provider: string): Promise<void> {
  if (process.env['FREE_TIER_QUOTA_SHADOW_ENABLED'] !== 'true') return;

  try {
    const cap = parseInt(process.env['FREE_TIER_DAILY_CAP_DEFAULT'] ?? '', 10);
    const dailyCallCap = Number.isFinite(cap) ? cap : DEFAULT_DAILY_CAP;

    const callsToday = await getFreeProviderCallsToday(provider);
    const decision = evaluateFreeTierQuota({ provider, callsToday, dailyCallCap });

    if (!decision.allowed) {
      console.log(
        '[FREE-TIER-QUOTA-SHADOW]',
        JSON.stringify({
          signal: 'free_quota_hit',
          provider,
          callsToday,
          dailyCallCap,
          reason: decision.reason,
        }),
      );
    }
  } catch (e: unknown) {
    console.warn('[FREE-TIER-QUOTA-SHADOW] error (inert):', (e as Error)?.message ?? e);
  }
}
