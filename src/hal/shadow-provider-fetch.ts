/**
 * HYP-5 shadow chokepoint. Live CALLSITES must not import this yet.
 * When they do, delete that file from CALLSITES and lower CALLSITE_CEILING.
 * Does not fetch. Does not change live egress.
 */
export async function providerFetch(_url: string, _init?: RequestInit): Promise<Response> {
  throw new Error('shadow-provider-fetch: shadow only — live callers must not import this yet');
}
