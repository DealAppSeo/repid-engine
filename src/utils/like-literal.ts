/**
 * Escape a string so a LIKE/ILIKE comparison matches it LITERALLY.
 *
 * WHY THIS EXISTS. Account lookups here resolve an email with `.ilike('email', value)`, and the
 * value is text the caller chose. `_` matches any single character in LIKE/ILIKE and `%` matches
 * any sequence, so an unescaped address is not a lookup — it is a PATTERN run against every
 * stored email. `_` is ordinary in the local part of a real address, which is what makes this
 * reachable without anything exotic.
 *
 * DIRECTION OF FAILURE, which is the part that decides the severity: the match resolves onto a
 * DIFFERENT account and the caller then mints a token for it. It fails open, not closed.
 *
 * WHY NOT JUST USE `.eq()`. Because that changes a second thing at the same time. These lookups
 * are case-insensitive on purpose — nothing guarantees every historical row was written
 * lowercase, and an exact-match switch would quietly stop finding those rows and mint a DUPLICATE
 * account instead. Escaping is a strict narrowing: it can only remove spurious matches, never
 * lose a real one.
 *
 * Backslash is escaped first, and must be: doing it later would re-escape the backslashes this
 * function had just introduced.
 */
export function likeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
