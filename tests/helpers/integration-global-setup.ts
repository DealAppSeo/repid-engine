/**
 * Jest globalSetup for the integration config (jest.integration.config.js).
 *
 * Runs ONCE before the integration suites. It performs the async
 * schema-presence probe here (Jest test files register `describe` blocks
 * synchronously and cannot await), then stashes the result in
 * `process.env.INTEGRATION_SCHEMA_PRESENT` so each write-path suite can
 * choose `describe` vs `describe.skip` synchronously at collection time.
 *
 * Set values:
 *   INTEGRATION_SCHEMA_PRESENT = 'true' | 'false'
 *
 * false when: no Supabase env, target is PROD, or the required tables are
 * absent (fresh/empty test project). A false result makes the write-path
 * suites SKIP (green) with a seed-me warning.
 */

import { hasSupabaseEnv, isProdSupabase, hasSchema, REQUIRED_TABLES } from './prod-guard';

export default async function integrationGlobalSetup(): Promise<void> {
  let present = false;
  let reason = '';

  if (!hasSupabaseEnv()) {
    reason = 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set';
  } else if (isProdSupabase()) {
    reason = 'target is the PRODUCTION project — write-path tests refuse to run against prod';
  } else {
    present = await hasSchema();
    if (!present) {
      reason = `test Supabase not seeded with schema (missing one of: ${REQUIRED_TABLES.join(', ')})`;
    }
  }

  process.env.INTEGRATION_SCHEMA_PRESENT = present ? 'true' : 'false';

  if (!present) {
    // eslint-disable-next-line no-console
    console.warn(
      `[integration] write-path suites will SKIP — ${reason}. ` +
        `Seed the test project to enable.`
    );
  }
}
