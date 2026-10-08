/**
 * jest setupFiles entry: no unit test reaches the live prover (BUS F-7, 2026-10-08).
 *
 * The prover base URL defaults to the pinned production service (src/config/prover.ts), so a unit
 * test that reaches a prover call without mocking fetch sent a real request to production. That is
 * how most of the prover's traffic in the week of 2026-10-07 came to be 404s and 500s from GitHub
 * Actions runner addresses, in bursts that lined up with engine CI. A fetch sniffer run over the
 * whole suite on 2026-10-08 named the path: the score-event pipeline POSTs /zkp/repid-proof.
 * Once the prover requires its token (F-10), those calls would also turn CI red with 401s.
 *
 * Same idea as offline-signature-chain.ts. A fetch to the prover's host is refused before it leaves,
 * as a network error, which the code already handles when the prover is down. A test that wants a
 * prover answer mocks fetch itself, which replaces this wrapper. RUN_INTEGRATION=1 lets the opt-in
 * integration suites through (tests/helpers/run-integration.ts).
 */
import { PINNED_PROVER_URL } from '../../src/config/prover';

export const OFFLINE_PROVER_MESSAGE = 'offline-prover: unit tests do not call the live prover';

const proverHosts = new Set<string>([new URL(PINNED_PROVER_URL).host]);
for (const v of [process.env.ZKP_SERVICE_URL, process.env.ZKP_POSTCARD_URL, process.env.PLONKY3_PROVER_URL]) {
  try {
    if (v) proverHosts.add(new URL(v).host);
  } catch {
    // not a URL; nothing to block
  }
}

const realFetch = globalThis.fetch;
if (process.env.RUN_INTEGRATION !== '1' && typeof realFetch === 'function') {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? input?.href ?? String(input);
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      // relative or malformed: not the prover
    }
    if (proverHosts.has(host)) throw new TypeError(`${OFFLINE_PROVER_MESSAGE} (${host})`);
    return realFetch(input, init);
  }) as typeof fetch;
}
