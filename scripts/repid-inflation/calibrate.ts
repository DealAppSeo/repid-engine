/**
 * RepID Inflation — population calibration for Patch B (counterparty gate) + Patch C tuning.
 *
 *   SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. DATABASE_URL=.. npx tsx scripts/repid-inflation/calibrate.ts
 *
 * Read-only. Prints: agent/RepID baseline, per-tier unique-counterparty distribution (delivered set
 * AND fulfilled-only — the spec's fulfilled-only filter misses disputed→resolved contracts), and the
 * tier-demotion impact of candidate counterparty thresholds. Drives the threshold proposal that must
 * be surfaced to Sean BEFORE Patch B is applied.
 *
 * "delivered" = contracts that reached a terminal delivery/resolution:
 *   status IN ('fulfilled','satisfied','settled','resolved').
 */
import { pgQuery } from '../../src/db/direct-pg';

const DELIVERED = `status IN ('fulfilled','satisfied','settled','resolved')`;

async function main() {
  const baseline = await pgQuery(
    `SELECT COUNT(*) total_active, ROUND(AVG(current_repid)) avg_repid, ROUND(STDDEV(current_repid)) stddev_repid,
            MIN(current_repid) min_repid, MAX(current_repid) max_repid
     FROM repid_agents WHERE lifecycle_status='active'`,
  );
  console.log('\n=== BASELINE (active agents) ===');
  console.table(baseline);

  const perTier = await pgQuery(
    `WITH cp AS (
       SELECT provider_agent_id aid, COUNT(DISTINCT buyer_agent_id) uniq
       FROM service_contracts WHERE ${DELIVERED} GROUP BY provider_agent_id
     )
     SELECT ra.tier,
            COUNT(*) agents,
            MIN(COALESCE(c.uniq,0)) min_cp,
            ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(c.uniq,0))::numeric,1) median_cp,
            ROUND(AVG(COALESCE(c.uniq,0)),1) avg_cp,
            MAX(COALESCE(c.uniq,0)) max_cp
     FROM repid_agents ra LEFT JOIN cp c ON c.aid=ra.id
     WHERE ra.lifecycle_status='active'
     GROUP BY ra.tier ORDER BY MIN(ra.current_repid)`,
  );
  console.log('\n=== PER-TIER UNIQUE COUNTERPARTIES (delivered set) ===');
  console.table(perTier);

  // Demotion impact for candidate threshold sets (auto, est, earn minimums).
  const sets: Array<{ name: string; auto: number; est: number; earn: number }> = [
    { name: 'sprint (auto10/est5/earn3)', auto: 10, est: 5, earn: 3 },
    { name: 'gentle (auto3/est2/earn1)', auto: 3, est: 2, earn: 1 },
    { name: 'grandfather (auto2/est1/earn0)', auto: 2, est: 1, earn: 0 },
    { name: 'zero-demote (auto2/est0/earn0)', auto: 2, est: 0, earn: 0 },
  ];
  console.log('\n=== TIER-DEMOTION IMPACT BY THRESHOLD SET ===');
  for (const s of sets) {
    const r = await pgQuery<{ demotions: string }>(
      `WITH cp AS (
         SELECT provider_agent_id aid, COUNT(DISTINCT buyer_agent_id) uniq
         FROM service_contracts WHERE ${DELIVERED} GROUP BY provider_agent_id
       ),
       a AS (
         SELECT ra.tier, COALESCE(c.uniq,0) cp
         FROM repid_agents ra LEFT JOIN cp c ON c.aid=ra.id
         WHERE ra.lifecycle_status='active'
       )
       SELECT COUNT(*) FILTER (
         WHERE (tier IN ('AUTONOMOUS','VETERAN') AND cp < $1)
            OR (tier='ESTABLISHED' AND cp < $2)
            OR (tier='EARNING' AND cp < $3)
       ) AS demotions
       FROM a`,
      [s.auto, s.est, s.earn],
    );
    console.log(`  ${s.name}: ${r[0]?.demotions ?? '?'} / ${baseline[0]?.total_active ?? '?'} demoted`);
  }
  console.log('\n(Surface these to Sean before applying Patch B. See OUTPUT report §2.)');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('calibrate failed:', e);
    process.exit(1);
  });
