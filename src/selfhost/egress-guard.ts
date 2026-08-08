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

export type EgressKind =
  | 'prompt' // prompt/response text going to an inference provider
  | 'embedding' // text going to an embedding provider (also content-bearing)
  | 'attestation' // EAS / proof anchor — a commitment, not content
  | 'chain'; // raw JSON-RPC to a blockchain node — a commitment, not content

// Egress kinds that carry user content. These are the ones the boundary blocks
// when it is engaged and the destination is not the local box.
const CONTENT_BEARING: ReadonlySet<EgressKind> = new Set<EgressKind>([
  'prompt',
  'embedding',
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
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // An unparseable URL is not provably local — treat as remote (fail-closed).
    return false;
  }
  // strip IPv6 brackets already handled by URL(); hostname has none.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // RFC1918 + link-local + CGNAT (private/self-hosted LAN targets like a vLLM box).
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.startsWith('169.254.')) return true;
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
  constructor(decision: EgressDecision) {
    super(
      `[egress-guard] blocked ${decision.kind} egress to ${decision.host ?? 'unparseable-url'} — ` +
        `ONLY_ATTESTATIONS_LEAVE is set, so prompt/response text may not leave the local box. ` +
        `Point LOCAL_LLM_BASE_URL at a local model (e.g. http://localhost:11434/v1) or unset the boundary.`,
    );
    this.name = 'EgressBoundaryError';
    this.decision = decision;
  }
}

function boundaryEngaged(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return (process.env.ONLY_ATTESTATIONS_LEAVE || '').toLowerCase() === 'true';
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
