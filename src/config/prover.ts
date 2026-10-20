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

/**
 * LOCAL_MODE PRIVACY (2026-10-20). A prover request carries an agent id and its score. A local engine
 * must not send those off the machine, so in LOCAL_MODE the prover is used only when it is on
 * loopback, the pin is never a default, and anything else resolves to null: no request is made.
 * Hosted (LOCAL_MODE off) is unchanged. Latched at load, latched again by src/config.ts when it picks
 * the local store, and read per call, so unsetting LOCAL_MODE after boot cannot re-open egress.
 * tests/prover-local-mode.test.ts holds this.
 */
let localLatched = (process.env.LOCAL_MODE || '').trim().toLowerCase() === 'true';

/** src/config.ts calls this when it picks the local store, so a local DB always means a local-only prover. */
export function latchProverLocalMode(): void {
  localLatched = true;
}

export function proverLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return localLatched || (env.LOCAL_MODE || '').trim().toLowerCase() === 'true';
}

/**
 * Every prover fetch passes `redirect: proverRedirect()`. LOCAL_MODE: 'error', because a loopback
 * prover answering 307/308 would otherwise have fetch re-send the body to any host (XC1 F1).
 * Hosted: 'follow', fetch's default, so hosted is unchanged.
 */
export function proverRedirect(env: NodeJS.ProcessEnv = process.env): 'error' | 'follow' {
  return proverLocalMode(env) ? 'error' : 'follow';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** http(s) on this machine's loopback, judged on the parsed host (never a prefix match). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

const warned = new Set<string>();

/** Every prover URL in src/ passes through here. Hosted: `url` unchanged. LOCAL_MODE: loopback or null. */
export function localProverGate(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!proverLocalMode(env) || isLoopbackUrl(url)) return url;
  let host = 'an unset or unparseable URL';
  try {
    if (url) host = new URL(url).host;
  } catch { /* keep the default */ }
  const msg =
    `[prover] LOCAL_MODE: refusing prover at ${host}; nothing is sent. ` +
    'Set ZKP_SERVICE_URL to a loopback prover (http://127.0.0.1:<port>) to prove locally.';
  if (!warned.has(msg)) {
    warned.add(msg);
    console.warn(msg);
  }
  return null;
}

/**
 * The prover base URL a service should call: its `ZKP_SERVICE_URL`, else the pinned one.
 * LOCAL_MODE: only a loopback `ZKP_SERVICE_URL`, else null, and the caller skips the proof.
 */
export function proverBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return localProverGate(env.ZKP_SERVICE_URL || PINNED_PROVER_URL, env);
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
