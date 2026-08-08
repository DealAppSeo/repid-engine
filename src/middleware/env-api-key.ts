/**
 * Pure, side-effect-free check: does a request carry a valid API key from the
 * REPID_API_KEYS env allowlist? Extracted so both the IP rate limiter and its
 * unit test can use it without importing the Redis/Dragonfly stack.
 *
 * REPID_API_KEYS is a comma-separated list of `key` or `key:tier` pairs (the same
 * format authMiddleware parses). This deliberately covers ONLY the env allowlist
 * — DB-issued keys (agent_api_keys) require an async DB lookup and are out of
 * scope for a synchronous, fail-open rate-limit bypass.
 */

/** Extract the presented key from `Authorization: Bearer <k>` or `x-api-key`. */
export function presentedApiKey(headers: {
  authorization?: string | string[] | undefined;
  'x-api-key'?: string | string[] | undefined;
}): string | null {
  const first = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const auth = first(headers.authorization);
  if (typeof auth === 'string' && auth.trim().length > 0) {
    const trimmed = auth.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    const key = ((bearer && bearer[1]) ? bearer[1] : trimmed).trim();
    if (key.length > 0) return key;
  }
  const xApiKey = first(headers['x-api-key']);
  if (typeof xApiKey === 'string' && xApiKey.trim().length > 0) return xApiKey.trim();
  return null;
}

/** True iff the presented key matches an entry in the REPID_API_KEYS allowlist. */
export function hasValidEnvApiKey(
  headers: {
    authorization?: string | string[] | undefined;
    'x-api-key'?: string | string[] | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const presented = presentedApiKey(headers);
  if (!presented) return false;
  const raw = env.REPID_API_KEYS ?? '';
  const keys = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return (idx >= 0 ? entry.slice(0, idx) : entry).trim();
    })
    .filter(Boolean);
  return keys.includes(presented);
}
