/**
 * CORS origin allow-list for the public Trust* ecosystem.
 *
 * Explicit origins below + any `trust*.dev` host (apex or www). The pattern is anchored so it
 * can't be spoofed by a look-alike (`trustchat.dev.evil.com` ends in `.com`; `eviltrust.dev` has
 * no `trust` prefix). The public endpoints (leaderboard, providers, security/status,
 * comparison/vote, session, subscribe, track) are read-mostly and consumed cross-origin by
 * trustchat.dev and the rest of the ecosystem.
 */
export const allowedOrigins = [
  'https://trustrepid.dev',
  'https://www.trustrepid.dev',
  'https://trustshell.dev',
  'https://www.trustshell.dev',
  'https://hyperdag.org',
  'https://www.hyperdag.org',
  'http://localhost:3000',
  'http://localhost:3001',
];

export const TRUST_DEV_ORIGIN = /^https:\/\/(www\.)?trust[a-z0-9-]*\.dev$/;
// hyperdag.org's Vercel deploys (production alias + preview builds), e.g. hyperdag-org.vercel.app,
// hyperdag-<hash>-dealappseos-projects.vercel.app. The `hyperdag` prefix is anchored to prevent spoofing.
export const HYPERDAG_VERCEL_ORIGIN = /^https:\/\/hyperdag[a-z0-9-]*\.vercel\.app$/;

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin) || TRUST_DEV_ORIGIN.test(origin) || HYPERDAG_VERCEL_ORIGIN.test(origin);
}
