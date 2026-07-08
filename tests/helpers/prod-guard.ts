/**
 * prod-guard — integration-test safety + readiness guards.
 *
 * Two independent gates, both feeding the `describeIfSchema` selector used by
 * the write-path integration suites:
 *
 *   1. PROD-SKIP (defense-in-depth):   `isProdSupabase()` — refuse to run
 *      write-path integration tests against the PRODUCTION Trinity project
 *      (qnnpjhlxljtqyigedwkb). Integration tests insert/update/delete rows;
 *      they must only ever touch a disposable TEST project.
 *
 *   2. SCHEMA-PRESENCE:   `hasSchema()` / `tablesExist()` — the fresh TEST
 *      project may be empty (no tables). Running write-path tests against it
 *      would fail on "relation does not exist" (Postgres 42P01). When the
 *      required tables are absent we SKIP the suite (green) rather than fail,
 *      and log a clear seed-me instruction.
 *
 * Both conditions gate the suite: it runs only when the target is NON-prod
 * AND the schema is present. Seed the test project's schema to enable.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Canonical PRODUCTION Supabase project ref — write-path tests must never hit it. */
export const PROD_PROJECT_REF = 'qnnpjhlxljtqyigedwkb';

/** Tables a write-path integration run needs; absence => empty/unseeded test DB. */
export const REQUIRED_TABLES = ['repid_events', 'service_contracts'] as const;

/** True when SUPABASE_URL/KEY are set at all (env present). */
export function hasSupabaseEnv(): boolean {
  return !!(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

/**
 * True when the configured SUPABASE_URL points at the PRODUCTION Trinity
 * project. Write-path integration tests refuse to run against prod.
 */
export function isProdSupabase(url: string | undefined = process.env.SUPABASE_URL): boolean {
  return !!url && url.includes(PROD_PROJECT_REF);
}

function testClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Returns true if `table` exists in the target Supabase project.
 *
 * Uses a HEAD/count select: PostgREST returns error code `42P01`
 * ("undefined_table") when the relation does not exist. Any other error
 * (auth, network) is treated as "cannot confirm" and returns false so the
 * suite skips rather than fails on an ambiguous DB state.
 */
export async function tableExists(table: string): Promise<boolean> {
  const client = testClient();
  if (!client) return false;
  const { error } = await client.from(table).select('*', { head: true, count: 'exact' }).limit(0);
  if (!error) return true;
  // Missing relation OR schema-cache miss for an unknown table => not present.
  const code = (error as { code?: string }).code;
  const msg = (error as { message?: string }).message || '';
  if (code === '42P01' || code === 'PGRST205' || /does not exist|find the table/i.test(msg)) {
    return false;
  }
  // Ambiguous (auth/network) — do not claim the schema is present.
  return false;
}

/** True only when ALL `tables` exist in the target project. */
export async function tablesExist(tables: readonly string[] = REQUIRED_TABLES): Promise<boolean> {
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await tableExists(t))) return false;
  }
  return true;
}

/** Alias: the write-path schema is present in the target project. */
export async function hasSchema(tables: readonly string[] = REQUIRED_TABLES): Promise<boolean> {
  return tablesExist(tables);
}
