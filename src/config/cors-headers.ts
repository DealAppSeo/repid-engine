/**
 * Which request headers a browser on another origin may send, and which response headers it may read.
 *
 * WHY THIS IS ITS OWN FILE [2026-10-07]. The allow-list in src/index.ts named four headers. The
 * engine READS eighteen. Three of the missing ones are sent by trustshell.dev from the browser,
 * and a browser refuses to send any header the preflight does not allow — so, in production:
 *   - every /bind died in preflight (x-hd-wallet, x-hd-timestamp, x-hd-signature), and the page
 *     said "unreachable" while the same route worked from curl;
 *   - every run after a person verified their email died the same way (x-agent-gate-token);
 *   - x-taste-remaining was set on every run and never readable by the page that shows it,
 *     because nothing exposed it.
 * Nothing was red: server tests call routes directly, and the web suites run against a stub whose
 * CORS is permissive. tests/cors-headers.test.ts now scans src for every `x-` header the engine
 * reads and fails until each one is classified below — a discovery rule, not a list that rots.
 *
 * Allowing a header grants nothing: it only lets a browser SEND it. Every route still checks
 * what the header says.
 */

/** Read from browsers on trustshell.dev and the other Trust* surfaces. */
export const BROWSER_HEADERS = [
  'x-api-key', // agent / operator key (spend, grants, keys)
  'X-RepID-Version', // API version pin (middleware/versioning)
  'x-hd-wallet', // wallet-proven requests (routes/v1/byok.ts)
  'x-hd-timestamp',
  'x-hd-signature',
  'x-agent-key', // the agent's own key, second side of a bind (services/human-agent-binding.ts)
  'x-agent-gate-token', // signed-in run budget (routes/agent-gate.ts, routes/route.ts)
  'x-payment', // x402 payment header; the published SDK sends it and can run in a browser
] as const;

/**
 * Read by the engine but only ever sent server-to-server (operators, webhooks, proxies). Listed so
 * the scan in tests/cors-headers.test.ts can tell "deliberately not for browsers" from "forgotten".
 * Moving one to BROWSER_HEADERS is fine the day a browser needs to send it.
 */
export const SERVER_ONLY_HEADERS = [
  'x-admin-key', // operator
  'x-enterprise-key', // operator / enterprise integration
  'x-sean-signature', // operator signature
  'x-telegram-bot-api-secret-token', // Telegram webhook
  'x-real-ip', // set by the proxy, never by a client
  'x-agent-name', // service callers labelling auth logs
  'x-sbt-wallet', // controller dashboard (server-side)
  'x-sbt-token',
  'x-controller-token',
  'x-byok-invite', // invite code for claimable tokens (operator tooling)
  'x-hyperdag-repid-attestation', // agent-to-agent attestation
  'x-cron-token', // scheduled triggers (routes/v1/internal-cron.ts, red-team.ts)
  'x-redteam-token', // red-team operator (routes/v1/red-team.ts)
  'x-payment-response', // read from UPSTREAM x402 responses when the engine is the client
] as const;

export const CORS_ALLOWED_HEADERS: string[] = ['Content-Type', 'Authorization', ...BROWSER_HEADERS];

/** Response headers a page is allowed to read. */
export const CORS_EXPOSED_HEADERS: string[] = [
  'x-taste-remaining', // runs left today (routes/route.ts); /run and /pai show it
];
