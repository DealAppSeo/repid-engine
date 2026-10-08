/**
 * THE ONE PROVER (Sean's decision, 2026-10-07: "Keep one prover. The engine should call one Railway
 * service, pinned.").
 *
 * The prover is DealAppSeo/HyperDAG-core `services/zkp-postcard`, deployed as the Railway service
 * `zkp-postcard`. MEASURED 2026-10-07: every proof job in the last 30 days recorded this URL, and the
 * proof-drain worker logs it at every start. A second deployment of the same folder (Railway project
 * `hyperdag-core`) took 0 requests in 7 days; nothing here may name it. Stopping it is the owner's.
 *
 * Every default in this repo reads this constant; `ZKP_SERVICE_URL` still overrides it per service.
 * tests/prover-pin.test.ts fails if any other prover host appears in src/.
 */
export const PINNED_PROVER_URL = 'https://zkp-postcard-production.up.railway.app';

/** The prover base URL a service should call: its `ZKP_SERVICE_URL`, else the pinned one. */
export function proverBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZKP_SERVICE_URL || PINNED_PROVER_URL;
}

/**
 * The bearer token every prover call carries (Sean's decision F-10, 2026-10-07: "Add authentication
 * on the prover"). The prover reads the same value as `PROVER_AUTH_TOKEN` and, once it requires it,
 * refuses calls without it. Sending it before the prover requires it is harmless, which is why the
 * engine ships this first. Unset sends no header; the call then fails at the prover, loudly.
 */
export function proverAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = (env.ZKP_SERVICE_TOKEN || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
