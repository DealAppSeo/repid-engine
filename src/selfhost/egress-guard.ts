/**
 * Data-locality egress boundary (ONLY_ATTESTATIONS_LEAVE).
 *
 * The self-host promise is "your data stays yours": when a user runs the engine
 * locally with a local model, prompt + response TEXT must never leave the box.
 * Proofs, EAS anchors and chain transactions MAY leave — they carry commitments
 * (hashes / signatures), not the content itself.
 *
 * This module is a PURE policy classifier plus one assertion. It has no network
 * or env side effects other than reading the flags it is handed (defaulting to
 * the process env at the call site). Wiring it into a call path is the caller's
 * job; keeping it pure is what makes it testable offline.
 *
 * Default-OFF: with ONLY_ATTESTATIONS_LEAVE unset, `assertPromptEgressAllowed`
 * is a no-op and hosted behavior is unchanged.
 */

import { isIP } from 'node:net';
import { parse as parsePgConnectionString } from 'pg-connection-string';

export type EgressKind =
  | 'prompt' // prompt/response text going to an inference provider
  | 'embedding' // text going to an embedding provider (also content-bearing)
  | 'datastore' // a persistent-store / cache SOCKET (pg / Redis) that holds rows + cached prompt/response text
  | 'attestation' // EAS / proof anchor — a commitment, not content
  | 'chain'; // raw JSON-RPC to a blockchain node — a commitment, not content

// Egress kinds that carry user content. These are the ones the boundary blocks
// when it is engaged and the destination is not the local box. `datastore` is
// here because Postgres rows and the Redis/Dragonfly caches hold the actual
// prompt/response TEXT — a remote store is a content leak just like a cloud LLM.
const CONTENT_BEARING: ReadonlySet<EgressKind> = new Set<EgressKind>([
  'prompt',
  'embedding',
  'datastore',
]);

/**
 * True when a URL's host is the local machine / a private network — i.e. the
 * data never leaves the operator's own trust boundary. Loopback, RFC1918
 * private ranges, link-local, and the docker/k8s service conventions all count
 * as "did not leave".
 */
export function isLocalHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL is not provably local — treat as remote (fail-closed).
    return false;
  }
  return isLocalHostname(host);
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // IP ranges apply ONLY to IP literals: '127.evil.example' is a DNS name its owner can point
  // anywhere, so string prefixes are not a locality test. WHATWG keeps IPv6 brackets ('[::1]').
  const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const version = isIP(ip);
  if (version === 6) return ip === '::1';
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]; // isIP()===4: four octets
    // loopback, 0.0.0.0, RFC1918 private LAN (e.g. a vLLM box), link-local.
    return (
      a === 127 ||
      ip === '0.0.0.0' ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Common single-host container/service names (docker-compose, k8s in-cluster).
  if (host === 'host.docker.internal') return true;
  if (host === 'ollama' || host === 'vllm' || host === 'llama-cpp') return true;
  return false;
}

export interface EgressDecision {
  allowed: boolean;
  kind: EgressKind;
  host: string | null;
  local: boolean;
  reason: string;
}

/**
 * Classify a single egress attempt against the boundary policy.
 *
 * @param url          destination URL
 * @param kind         what is being sent
 * @param boundaryOn   whether ONLY_ATTESTATIONS_LEAVE is engaged
 */
export function classifyEgress(
  url: string,
  kind: EgressKind,
  boundaryOn: boolean,
): EgressDecision {
  let host: string | null = null;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = null;
  }
  const local = isLocalHost(url);

  // Boundary disengaged → everything allowed (hosted behavior unchanged).
  if (!boundaryOn) {
    return { allowed: true, kind, host, local, reason: 'boundary-off' };
  }
  // Commitment-only egress (proofs, EAS, chain RPC) is always permitted — that
  // is the whole "only attestations leave" allowance.
  if (!CONTENT_BEARING.has(kind)) {
    return { allowed: true, kind, host, local, reason: 'commitment-egress-allowed' };
  }
  // Content-bearing egress is allowed only to the local box.
  if (local) {
    return { allowed: true, kind, host, local, reason: 'local-target' };
  }
  return {
    allowed: false,
    kind,
    host,
    local,
    reason: 'content-egress-blocked-by-ONLY_ATTESTATIONS_LEAVE',
  };
}

export class EgressBoundaryError extends Error {
  readonly decision: EgressDecision;
  constructor(decision: EgressDecision, message?: string) {
    super(
      message ??
        `[egress-guard] blocked ${decision.kind} egress to ${decision.host ?? 'unparseable-url'} — ` +
          `ONLY_ATTESTATIONS_LEAVE is set, so prompt/response text may not leave the local box. ` +
          `Point LOCAL_LLM_BASE_URL at a local model (e.g. http://localhost:11434/v1) or unset the boundary.`,
    );
    this.name = 'EgressBoundaryError';
    this.decision = decision;
  }
}

/**
 * THE one reader of ONLY_ATTESTATIONS_LEAVE. Every other module calls this rather than
 * comparing the variable itself; tests/boundary-trim.test.ts fails if any other file in src/
 * reads it. Trimmed and case-insensitive: 'TRUE ' from a dashboard copy-paste must read as ON,
 * never as off (CC2 re-check of #1171).
 */
export function onlyAttestationsLeave(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ONLY_ATTESTATIONS_LEAVE || '').trim().toLowerCase() === 'true';
}

function boundaryEngaged(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return onlyAttestationsLeave();
}

/**
 * Throw if this content-bearing egress would violate the boundary. No-op when
 * the boundary is off or the target is local, or when the egress is a
 * commitment (attestation/chain). Reads ONLY_ATTESTATIONS_LEAVE from env unless
 * `boundaryOn` is passed explicitly (tests pass it explicitly).
 */
export function assertPromptEgressAllowed(
  url: string,
  kind: EgressKind = 'prompt',
  boundaryOn?: boolean,
): void {
  const decision = classifyEgress(url, kind, boundaryEngaged(boundaryOn));
  if (!decision.allowed) {
    throw new EgressBoundaryError(decision);
  }
}

/**
 * Assert a persistent-store / cache connection string points at the LOCAL box
 * when the boundary is engaged. Postgres (`DATABASE_URL`) holds every row, and
 * the Redis/Dragonfly caches (`REDIS_URL`) hold cached prompt/response TEXT — so
 * both are CONTENT-bearing. These open raw TCP sockets via `pg` / `ioredis`, NOT
 * `fetch`, so the fetch-level boundary (`assertPromptEgressAllowed`) never sees
 * them; this assertion is the explicit close for that gap.
 *
 * Under `ONLY_ATTESTATIONS_LEAVE`, a NON-local store host is REFUSED
 * (throws `EgressBoundaryError`) — the node stays provably data-local even if
 * `DATABASE_URL` / `REDIS_URL` is misconfigured to point at a remote host. An
 * unparseable connection string is treated as remote (fail-closed).
 *
 * No-op when the boundary is off (hosted behavior byte-identical) or the host is
 * local/private. What is classified is the host the store's CLIENT will dial,
 * which is not always `new URL().hostname` — see `storeDialHost`.
 *
 * @param connectionString  DATABASE_URL / REDIS_URL (or equivalent)
 * @param storeLabel        which client consumes it: 'DATABASE_URL' = `pg`, 'REDIS_URL' = `ioredis`
 * @param boundaryOn        override for ONLY_ATTESTATIONS_LEAVE (tests pass explicitly)
 */
export function assertLocalDataStore(
  connectionString: string,
  storeLabel: 'DATABASE_URL' | 'REDIS_URL',
  boundaryOn?: boolean,
): void {
  // Boundary off → no-op (hosted behavior unchanged).
  if (!boundaryEngaged(boundaryOn)) return;
  const host = storeDialHost(connectionString, storeLabel);
  // Local / private host → the content never left the operator's box.
  if (host !== null && isLocalStoreHost(host)) return;

  const decision: EgressDecision = {
    allowed: false,
    kind: 'datastore',
    host,
    local: false,
    reason: `content-store-egress-blocked-by-ONLY_ATTESTATIONS_LEAVE:${storeLabel}`,
  };
  throw new EgressBoundaryError(
    decision,
    `[egress-guard] refusing ${storeLabel} connection to non-local host ${host ?? '(none or unparseable)'} — ` +
      `ONLY_ATTESTATIONS_LEAVE is set, so the datastore (rows + cached prompt/response text) may not ` +
      `leave the local box. Point ${storeLabel} at a local store (e.g. localhost / 127.0.0.1 / a private ` +
      `LAN host) or unset the boundary.`,
  );
}

/**
 * The host the store's client will dial; null = none or unparseable (refused).
 *
 * DATABASE_URL: `pg` runs pg-connection-string's parse() on the connection string, and parse()
 * lets a `?host=` query parameter override the URL authority (last one wins), so
 * `postgresql://u:p@127.0.0.1/db?host=evil.example` dials evil.example. The guard runs the same
 * parse() (tests/selfhost-datastore-egress.test.ts checks it is the copy pg loads). An empty host
 * falls back to PGHOST / 'localhost' at connect time, which is not provable here, so it is refused.
 * parse() also reads any sslcert/sslkey/sslrootcert file, as pg would; a read error refuses.
 *
 * REDIS_URL: ioredis keeps the URL host over a `?host=` parameter (checked in the same test), so
 * the URL hostname is classified. ioredis does dial a `?path=` socket path instead of the host;
 * that is NOT classified here yet (on Windows '//server/pipe/…' is a pipe on another machine).
 */
function storeDialHost(connectionString: string, storeLabel: 'DATABASE_URL' | 'REDIS_URL'): string | null {
  try {
    if (storeLabel === 'DATABASE_URL') return parsePgConnectionString(connectionString).host || null;
    return new URL(connectionString).hostname || null;
  } catch {
    return null;
  }
}

function isLocalStoreHost(host: string): boolean {
  // pg dials a '/'-prefixed host as a Unix socket path: a file on this box, so local. Not
  // '//x/…' or '/\x\…': Windows reads those as UNC paths, i.e. a named pipe on machine x
  // (checked on loopback: net.connect({ path: '//localhost/pipe/p' }) reaches \\.\pipe\p).
  if (host.startsWith('/')) return !/^\/[/\\]/.test(host);
  return isLocalHostname(host);
}
