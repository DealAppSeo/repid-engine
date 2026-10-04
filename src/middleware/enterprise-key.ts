/**
 * Does this request carry the enterprise key that exempts it from the registration ceiling?
 *
 * WHY THIS IS ITS OWN FUNCTION. The check used to be inline in `registrationLimiter.skip`:
 *
 *     req.headers['x-enterprise-key'] === process.env.ENTERPRISE_API_KEY
 *
 * `ENTERPRISE_API_KEY` is not set on the production service [MEASURED 2026-10-04, Railway variable
 * names], and a caller that sends no header has `undefined` there too. `undefined === undefined` is
 * true, so EVERY ordinary request was exempt and the 5-per-hour registration ceiling never fired —
 * an unset secret read as a matching one. Same house defect as NOT_CHECKED scored as PASSED: the
 * absence of the thing was accepted as the thing.
 *
 * So: no configured key means nobody is exempt, an empty or array header never matches, and the
 * comparison is constant-time so the key cannot be guessed a byte at a time.
 */
import { createHash, timingSafeEqual } from 'crypto';

export function enterpriseKeyMatches(header: unknown, configured: string | undefined = process.env.ENTERPRISE_API_KEY): boolean {
  const expected = (configured ?? '').trim();
  if (!expected) return false;
  if (typeof header !== 'string') return false;
  const given = header.trim();
  if (!given) return false;
  // Hash both sides so timingSafeEqual sees equal lengths and the key length does not leak.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
