/**
 * Local route for a piece of text. No network and no paid API.
 * Blank or a question asks. A long note, or one that names an attestation,
 * a proof, a quorum, a stake, or a contract, escalates. Everything else is cheap.
 * The cheap route reuses the local postcard commitment. The preimage is a fixed
 * fixture, never the caller's text.
 */
import { postcardCommitmentSha256 } from '../zkp/commitment';

export type LayaRoute = 'cheap' | 'escalate' | 'ask';

export interface LayaClassification {
  route: LayaRoute;
  latency_ms: number;
  reuse: 'postcard' | null;
  postcard: string | null;
}

const POSTCARD_FIXTURE = {
  agentId: '00000000-0000-0000-0000-000000000000',
  score: 0,
  tier: 'PROBATIONARY',
  nonce: '0x' + '11'.repeat(16),
};

const HEAVY = /\b(attest|proof|quorum|stake|contract)\b/i;
const LONG = 280;

export function classify(
  text: string,
  clock: () => number = () => performance.now(),
): LayaClassification {
  const started = clock();
  const route = routeOf(text);
  const postcard = route === 'cheap' ? postcardCommitmentSha256(POSTCARD_FIXTURE) : null;
  const latency_ms = Math.max(0, clock() - started);
  return {
    route,
    latency_ms,
    reuse: route === 'cheap' ? 'postcard' : null,
    postcard,
  };
}

function routeOf(text: string): LayaRoute {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'ask';
  if (trimmed.includes('?')) return 'ask';
  if (trimmed.length > LONG || HEAVY.test(trimmed)) return 'escalate';
  return 'cheap';
}
