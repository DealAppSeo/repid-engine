/**
 * A `principal` id must be a canonical UUID. Anything else is rejected BEFORE it
 * reaches the PostgREST `.or()` filter in `listGrants` — a comma in the value would
 * otherwise become a second, attacker-chosen OR term and disclose the whole
 * principal_grants table to an unauthenticated caller.
 *
 * No imports on purpose: the guard is unit-testable in isolation, with no database
 * or config boot. (The repo keeps a per-file copy of this regex in ~15 places; this
 * one exists so the grants read path and its sink can share a single checked guard.)
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidPrincipal(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
