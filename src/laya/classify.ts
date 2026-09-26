/**
 * Local route for a piece of text. No network and no paid API.
 * Blank or a question asks. A long note, or one that names an attestation,
 * a proof, a quorum, a stake, or a contract, escalates. Everything else is cheap.
 */

export type LayaRoute = 'cheap' | 'escalate' | 'ask';

export interface LayaClassification {
  route: LayaRoute;
  latency_ms: number;
}

const HEAVY = /\b(attest|proof|quorum|stake|contract)\b/i;
const LONG = 280;

export function classify(
  text: string,
  clock: () => number = () => performance.now(),
): LayaClassification {
  const started = clock();
  const route = routeOf(text);
  const latency_ms = Math.max(0, clock() - started);
  return { route, latency_ms };
}

function routeOf(text: string): LayaRoute {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'ask';
  if (trimmed.includes('?')) return 'ask';
  if (trimmed.length > LONG || HEAVY.test(trimmed)) return 'escalate';
  return 'cheap';
}
