/**
 * P0 coverage for PROOF_CARRYING_RETRIEVAL_v0 — the fork-independent core.
 * Proves the two properties that make retrieval "proof-carrying":
 *   1. a valid inclusion proof verifies to the committed root, and
 *   2. anything NOT in the committed memory (forged leaf or tampered path) fails.
 * hash2 is a mock (sha256) — the same tests pass unchanged once Poseidon2 is injected.
 */
import crypto from 'crypto';
import {
  leafHash, verifyInclusion, referenceRoot, referenceProof,
  type MemoryLeaf, type Hash2,
} from '../src/memory/proof-carrying-index';

// order-sensitive mock 2-to-1 hash standing in for Poseidon2 (backlog 4.0 leaf)
const h2: Hash2 = (a, b) => crypto.createHash('sha256').update(a + '|' + b).digest('hex');

function mkLeaf(i: number): MemoryLeaf {
  return {
    content_hash: `content-${i}`,
    provenance: { source_id: `agent-${i}`, source_repid: 1000 + i, hal_verdict: 'clean', timestamp: 1_700_000_000_000 + i, epoch: 1 },
  };
}

describe('proof-carrying-index P0 — inclusion verify (fork-independent)', () => {
  const leaves = Array.from({ length: 6 }, (_, i) => leafHash(mkLeaf(i), h2));
  const root = referenceRoot(leaves, h2);

  it('every valid inclusion proof verifies to the committed root', () => {
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyInclusion(leaves[i]!, referenceProof(leaves, i, h2), root, h2)).toBe(true);
    }
  });

  it('a forged leaf (never committed) cannot produce a passing proof', () => {
    const forged = leafHash(mkLeaf(999), h2);
    expect(verifyInclusion(forged, referenceProof(leaves, 0, h2), root, h2)).toBe(false);
  });

  it('a tampered path fails verification', () => {
    const bad = referenceProof(leaves, 2, h2).map((s, i) => (i === 0 ? { ...s, sibling: 'deadbeef' } : s));
    expect(verifyInclusion(leaves[2]!, bad, root, h2)).toBe(false);
  });

  it('leafHash is deterministic and provenance-sensitive', () => {
    const a = leafHash(mkLeaf(1), h2);
    const b = leafHash(mkLeaf(1), h2);
    const provChanged = leafHash({ ...mkLeaf(1), provenance: { ...mkLeaf(1).provenance, source_repid: 9999 } }, h2);
    expect(a).toBe(b);
    expect(a).not.toBe(provChanged); // changing provenance changes the commitment
  });
});
