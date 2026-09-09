/**
 * provider-fetch.ts — THE named egress chokepoint for LLM provider calls.
 *
 * Layer 3 of the egress work (layers 1 and 2 are the two CI guards). This exists so that
 * "every provider call goes through one place" has an actual place to name — created BEFORE
 * anything calls it, on purpose: if the chokepoint does not exist yet, every adapter grows its
 * own private `fetch` while waiting, and then there is nothing to route through.
 *
 * ── WHAT IT IS TODAY: a behaviour-preserving passthrough to the global `fetch`.
 * It changes NOTHING about which host is reached, which header is sent, or what comes back.
 * That is deliberate for this slice — the constraint is no runtime behaviour change and no
 * alteration to which host production traffic reaches. The value delivered now is the NAME and
 * the single seam, not any new behaviour.
 *
 * ── WHAT ATTACHES HERE LATER (each its own reviewed slice, none of it in this one):
 *   - base-URL resolution (today scattered as `resolveProviderEndpoint` call-by-call),
 *   - credential presentation + the assertion of WHICH credential source resolved,
 *   - the `ONLY_ATTESTATIONS_LEAVE` egress-boundary check (src/selfhost/egress-guard.ts),
 *   - the Sealer.
 * They attach HERE, once, instead of in each of the ~13 callsites the hostname guard counts.
 *
 * ── HOW A CALLSITE RETIRES ITSELF: replace a direct `fetch(<provider-url>, init)` with
 * `providerFetch(<provider-url>, init)` AND move the host literal out of the callsite (to the
 * provider registry), so the file stops naming a provider host. That removes one line from the
 * CALLSITES list in provider-egress-guard.test.ts and lowers its ceiling by one. Routing live
 * production fetches is a later slice; this file must land first.
 */

/**
 * Call an LLM provider. A 1:1 passthrough to `fetch` today; the single point every provider
 * egress will route through.
 *
 * Typed as the global `fetch` signature so it is a drop-in: `fetch(url, init)` becomes
 * `providerFetch(url, init)` with no call-site shape change.
 */
export function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}

export type ProviderFetch = typeof providerFetch;
