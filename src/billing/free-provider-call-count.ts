import { db } from '../db';

/**
 * getFreeProviderCallsToday — answers backlog item 9's decision (a) named by beat 81
 * (reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md, `src/billing/free-tier-quota.ts`):
 * "where the per-provider daily call count is actually tracked." No new column: counts
 * `llm_call_log` rows live, the same table `./llm-calls-24h.ts` already pages through for the
 * cost/efficiency dashboards. A 24h rolling window, matching that existing convention rather
 * than inventing a second one (calendar-day-since-midnight).
 *
 * Read-only, no caller yet. `evaluateFreeTierQuota` (./free-tier-quota.ts) still needs a
 * configured `dailyCallCap` per provider and a decision on whether it plugs into router.ts's
 * `cap_hit` reason or reports a distinct one, plus the fail-open-vs-closed choice when this
 * count is unavailable — beat 81's decisions (b) and (c), neither of which this closes.
 */
export async function getFreeProviderCallsToday(provider: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await db
    .from('llm_call_log')
    .select('call_id', { count: 'exact', head: true })
    .eq('provider', provider)
    .gte('created_at', since);

  if (error) throw new Error(error.message);
  return count ?? 0;
}
