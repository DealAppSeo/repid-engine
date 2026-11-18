/**
 * dispatch-digest.ts — the five-line status the operator reads on a phone.
 * Always exactly five lines, in this order, each one line and short enough for a narrow screen.
 */

export interface DigestInput {
  coverage: { total: number; active: number; ready: number; blocked: number; finished: number };
  verified: { independentlyVerified: number; finished: number; notChecked: number };
  /** Decisions waiting on the operator, each with its exact action. Empty means none. */
  decisions: string[];
  headroom: string;
  next: string;
}

export const DIGEST_LINE_MAX = 80;

const one = (s: string) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > DIGEST_LINE_MAX ? flat.slice(0, DIGEST_LINE_MAX - 1) + '…' : flat;
};

export function renderDigest(d: DigestInput): string {
  const c = d.coverage;
  const v = d.verified;
  const decision = d.decisions.length === 0 ? 'none waiting' : d.decisions.length === 1 ? d.decisions[0]! : `${d.decisions.length} waiting; first: ${d.decisions[0]}`;
  return [
    one(`Coverage: ${c.finished}/${c.total} finished, ${c.active} active, ${c.ready} ready, ${c.blocked} blocked`),
    one(`Verified: ${v.independentlyVerified}/${v.finished} independently, ${v.notChecked} not checked`),
    one(`Decision: ${decision}`),
    one(`Headroom: ${d.headroom || 'unknown'}`),
    one(`Next: ${d.next || 'unknown'}`),
  ].join('\n');
}
