/**
 * CHECK 3 — RLS invariant on the security-critical tables.
 * Asserts every CRITICAL table that exists has rowsecurity=true, and reports the total
 * count of RLS-disabled public tables. Catches a table losing RLS (regression) and surfaces
 * the standing RLS gap.
 *
 * NOTE: the engine writes with the service-role key (which bypasses RLS), so RLS-off is not
 * an engine-write bug — it's a defense-in-depth gap that matters the moment any anon/auth or
 * PostgREST path touches these tables. repid_score_events being RLS-off is a real finding.
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { sqlExec, getDb } from '../lib/db';

const ID = 'rls';
const TITLE = 'RLS on CRITICAL-16 + repid_score_events';

/**
 * The harness's canonical CRITICAL set — identity, economic, audit, and key-material tables
 * whose RLS-off = real exposure. Adjust here (and document) when adding a new critical table.
 */
export const CRITICAL_TABLES = [
  'repid_agents', 'repid_score_events', 'repid_agent_stakes', 'stake_deposits',
  'service_contracts', 'user_api_keys', 'repid_zkp_proofs', 'agent_reports',
  'dispatch_queue', 'repid_badges', 'repid_bounties', 'trinity_agent_logs',
  'hal_production_events', 'api_key_versions', 'x402_settlements', 'repid_ecosystem_supply',
];

export async function rlsCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  let critRows: Array<{ tablename: string; rowsecurity: boolean }>;
  let disabledTotal: number;
  try {
    const inList = CRITICAL_TABLES.map(t => `'${t}'`).join(',');
    critRows = await sqlExec(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN (${inList}) ORDER BY tablename`,
    );
    const tot = await sqlExec<{ off: number }>(
      `SELECT count(*)::int AS off FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity`,
    );
    disabledTotal = Number(tot[0]?.off ?? -1);
  } catch (e: any) {
    return skip(ID, TITLE, `DB query failed: ${e?.message ?? e}`, true);
  }

  const existing = new Set(critRows.map(r => r.tablename));
  const missingTables = CRITICAL_TABLES.filter(t => !existing.has(t)); // not in schema (informational)
  const offenders = critRows.filter(r => !r.rowsecurity).map(r => r.tablename);

  const detail = {
    critical_checked: critRows.length,
    critical_rls_off: offenders,
    critical_not_in_schema: missingTables,
    public_tables_rls_disabled_total: disabledTotal,
  };

  if (offenders.length === 0) {
    return pass(ID, TITLE, `all ${critRows.length} critical tables RLS-on (${disabledTotal} public tables RLS-off overall)`, true, detail);
  }
  return fail(ID, TITLE, `RLS OFF on ${offenders.length} critical: ${offenders.join(', ')} (${disabledTotal} disabled overall)`, true, detail);
}
