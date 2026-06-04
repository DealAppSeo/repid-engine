/**
 * TIMEZONE single source of truth (R3).
 * todayPT() always returns 'YYYY-MM-DD' in America/Los_Angeles.
 * Use this instead of new Date().toISOString().slice(0,10) or now()::date in app code.
 * Revertible: remove import and calls, drop TZ rec in CONTRIBUTING.
 * Test: evening PT should not roll to next day label.
 */
export function todayPT(): string {
  // en-CA gives YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * For SQL: (now() AT TIME ZONE 'America/Los_Angeles')::date
 * Recommend env TZ=America/Los_Angeles on Railway (see CONTRIBUTING).
 */
export const TODAY_PT_SQL = `(now() AT TIME ZONE 'America/Los_Angeles')::date`;

export const TIMEZONE = 'America/Los_Angeles';
