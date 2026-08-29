/**
 * Probe: the LIVE /api/v1/hal/evaluate response shape — against a deliberately un-cacheable
 * request.
 *
 * WHY THIS EXISTS. The other HAL probe counts rows in the database. Nothing checked what the
 * HTTP endpoint actually returns, and that is where a real defect hid: `independent_hosts` was
 * computed, typed, returned internally and unit-tested, then dropped at the projection in
 * service.ts. It shipped.
 *
 * WORSE, AND THE ACTUAL REASON THIS FILE IS HERE: the verification of the fix was itself broken.
 * `/hal/evaluate` caches on `(text, strictness)`, and the check re-sent the SAME sentence that
 * had been sent before the deploy. The TTL served the pre-deploy verdict, the field was absent,
 * and a working fix was reported as broken. A probe that reuses its input cannot distinguish
 * "not deployed" from "answered from cache" — it has no way to fail correctly, which makes its
 * passes worth nothing either.
 *
 * TWO MECHANISMS, because the nonce alone is not enough:
 *   1. A nonce in the text, so the cache key cannot collide with any earlier request.
 *   2. An ASSERTION that the response is not `cached: true`. Without this the cache-bust could
 *      silently stop working — the key could start normalising punctuation or whitespace — and
 *      this probe would go quietly back to reading stale answers. The nonce is the attempt; the
 *      assertion is the proof.
 *
 * Read-only: one POST to a public, keyless endpoint. Writes nothing.
 */
import { ProbeResult } from './_shared';

const BASE = process.env.REPID_ENGINE_URL?.replace(/\/+$/, '')
  || 'https://repid-engine-production.up.railway.app';

/** A claim whose truth does not depend on the nonce, so the verdict stays meaningful. */
function nonced(): string {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `The capital of France is Paris. [liveness probe ${nonce}]`;
}

export async function probeHalResponseShape(): Promise<ProbeResult> {
  const name = 'hal-response-shape';
  let body: any;
  try {
    const res = await fetch(`${BASE}/api/v1/hal/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: nonced() }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { name, status: 'RED', metrics: { http: res.status }, message: `HTTP ${res.status}` };
    }
    body = await res.json();
  } catch (e: any) {
    // Unreachable is NOT the same as wrong: AMBER, and say which it is.
    return {
      name, status: 'AMBER', metrics: { reachable: false },
      message: `endpoint unreachable (${e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e}) — NOT CHECKED, not failed`,
    };
  }

  // THE CACHE-BUST MUST BE PROVEN, NOT ASSUMED.
  if (body?.cached === true) {
    return {
      name, status: 'RED',
      metrics: { cached: true },
      message: 'served from cache despite a nonced input — the cache-bust has stopped working, so every other assertion here is unverifiable',
    };
  }

  const s = body?.signals ?? {};
  const providersUsed = s.providers_used;
  const families = s.families_used;
  const hosts = s.independent_hosts;

  if (typeof hosts !== 'number') {
    return {
      name, status: 'RED',
      metrics: { families_used: families, independent_hosts: hosts ?? null, mode: body?.mode },
      message: 'independent_hosts absent from a FRESH evaluation — the field is not reaching callers',
    };
  }

  // THE INVARIANT, AND THE ONE I GOT WRONG. Hosts and families are two independent dedupes of
  // the same successful verdicts, so NEITHER bounds the other: consolidation puts many families
  // behind one host, while two hosts serving one model family give more hosts than families.
  // An earlier check asserted independent_hosts <= families_used and would have failed on the
  // live panel (5 hosts, 4 families — two hosts serving the same family). Both are bounded only
  // by the number of providers that answered.
  const bad: string[] = [];
  if (hosts < 1) bad.push(`independent_hosts=${hosts} < 1`);
  if (typeof families !== 'number' || families < 1) bad.push(`families_used=${families} invalid`);
  if (typeof providersUsed === 'number') {
    if (hosts > providersUsed) bad.push(`independent_hosts=${hosts} > providers_used=${providersUsed}`);
    if (typeof families === 'number' && families > providersUsed) {
      bad.push(`families_used=${families} > providers_used=${providersUsed}`);
    }
  }
  if (bad.length) {
    return { name, status: 'RED', metrics: { families_used: families, independent_hosts: hosts, providers_used: providersUsed }, message: bad.join('; ') };
  }

  return {
    name,
    status: 'GREEN',
    metrics: {
      mode: body?.mode, providers_used: providersUsed,
      families_used: families, independent_hosts: hosts,
      // Surfaced because it is the number consolidation is judged by: more families than hosts
      // means one outage takes several voices with it.
      families_per_host: Number((families / hosts).toFixed(2)),
      fresh: true,
    },
  };
}

// Standalone entry: `npm run probe:hal-shape`. Exit 0 GREEN, 2 AMBER (not checked), 1 RED —
// the repo's convention, so "could not look" never reads as "looked and failed".
if (require.main === module) {
  probeHalResponseShape()
    .then((r) => {
      console.log(`[${r.status}] ${r.name} ${JSON.stringify(r.metrics)}${r.message ? ' — ' + r.message : ''}`);
      process.exit(r.status === 'GREEN' ? 0 : r.status === 'AMBER' ? 2 : 1);
    })
    .catch((e) => { console.error('[RED] probe threw:', e?.message ?? e); process.exit(1); });
}
