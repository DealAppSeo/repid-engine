/**
 * Open (any-origin, no-credentials) CORS for a short, named list of PUBLIC READ routes.
 *
 * WHY. The global CORS allow-list (src/index.ts) answers a non-allow-listed Origin with an
 * Error, which Express renders as a 500 HTML page — no Access-Control-Allow-Origin, nothing
 * a browser can read. That is correct for everything that mutates or spends. It is wrong for
 * the read endpoints a stranger's tool needs: the browser extension's RepID lookup, a page on
 * any site, the CLI behind a proxy. MEASURED: the extension popup only worked because
 * host_permissions makes Chrome omit the Origin header, which the allow-list waves through
 * (`!origin`). A content script, or a Chrome that sends `chrome-extension://…`, got the 500
 * and the UI degraded silently to "Proof not checked".
 *
 * `POST /api/v1/classify` solved the same problem by mounting itself ahead of the allow-list.
 * That also skips the global rate limiter, emergency-halt and auth ordering, which these
 * routes should keep. So this does the narrower thing: it swaps ONLY the CORS policy for
 * the routes below, and every other middleware still runs in its usual order.
 *
 * WHAT MAKES THIS SAFE TO OPEN, and what keeps it that way:
 *   - The route list is explicit and every entry is a GET handler that reads public data and
 *     writes nothing. It is a list on purpose: a route is open only when someone put it here.
 *   - It matches only GET / HEAD, or a preflight that asks for GET / HEAD. A POST, PUT, PATCH
 *     or DELETE, and a preflight asking for one, never reaches the open policy even on a path
 *     in the list — it falls through to the allow-list unchanged.
 *   - `credentials: false` with `origin: '*'`. A browser will not attach cookies or an
 *     Authorization header to such a request, and these routes read none (auth is bypassed
 *     for them). Opening them grants a page nothing a `curl` did not already have.
 *   - Allowed request headers are Content-Type and the version pin only. Not x-api-key, not
 *     the wallet-signature headers: nothing on these routes needs a secret.
 *
 * NOT here, on purpose: /repid/:id/history, /repid/:id/zkp, /repid/preview/*, POST /repid/verify,
 * POST /proof/verify. They are not on the stranger path; add them to the list when they are,
 * with a test, rather than widening a pattern.
 */
import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * Public, read-only, keyless GET routes. Each is paired with the handler that serves it; the
 * test (tests/open-read-cors.test.ts) drives the real app against every entry.
 * Case-insensitive and tolerant of a trailing slash, because Express routing is both.
 */
export const OPEN_READ_ROUTES: readonly RegExp[] = [
  /^\/api\/v1\/repid\/[^/]+\/?$/i, //                GET /repid/:agentId          (src/routes/repid.ts)
  /^\/api\/v1\/repid\/[^/]+\/proof\/?$/i, //         GET /repid/:agentId/proof    (src/routes/repid.ts)
  /^\/api\/v1\/repid\/proof\/[^/]+\/?$/i, //         GET /repid/proof/:job_id     (src/routes/repid.ts)
  /^\/api\/v1\/passport\/[^/]+\/?$/i, //             GET /passport/:agentId       (src/routes/v1/agent-passport.ts)
  /^\/api\/v1\/faucet\/(?:info|balance)\/?$/i, //    GET /faucet/info, /faucet/balance (src/routes/faucet.ts; never dispenses)
];

const READ_METHODS = new Set(['GET', 'HEAD']);

/** The slice of a request the decision needs, so it can be tested without a socket. */
export interface OpenReadProbe {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * True when this request should get the open policy: a read method (or a preflight asking for
 * a read method) on a listed path. Anything else is the allow-list's business.
 */
export function isOpenReadRequest(req: OpenReadProbe): boolean {
  if (!OPEN_READ_ROUTES.some((re) => re.test(req.path))) return false;
  const method = req.method.toUpperCase();
  if (READ_METHODS.has(method)) return true;
  if (method !== 'OPTIONS') return false;
  const asked = req.headers['access-control-request-method'];
  const askedMethod = (Array.isArray(asked) ? asked[0] : asked) ?? '';
  return READ_METHODS.has(askedMethod.toUpperCase());
}

const openReadCors = cors({
  origin: '*',
  credentials: false,
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-RepID-Version'],
});

/**
 * Wrap the engine's global CORS middleware: listed read routes get the open policy, every
 * other request gets `fallback` untouched.
 */
export function withOpenReadCors(fallback: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (isOpenReadRequest(req)) return openReadCors(req, res, next);
    return fallback(req, res, next);
  };
}
