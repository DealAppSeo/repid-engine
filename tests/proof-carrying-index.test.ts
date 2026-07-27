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
  hashNode, DOMAIN_LEAF, DOMAIN_NODE,
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

describe('proof-carrying-index P0 — Merkle hardening (domain sep + non-malleability)', () => {
  // ODD leaf count so the last node is lone — this is exactly where CVE-2012-2459 bites.
  const leaves5 = Array.from({ length: 5 }, (_, i) => leafHash(mkLeaf(i), h2));

  it('closes CVE-2012-2459: a duplicated-leaf tree cannot forge the same root', () => {
    const rootHonest = referenceRoot(leaves5, h2);
    // The classic malleability: append a copy of the last leaf. Under the old
    // duplicate-odd-node scheme this yields an IDENTICAL root; promotion must differ.
    const rootForged = referenceRoot([...leaves5, leaves5[4]!], h2);
    expect(rootForged).not.toBe(rootHonest);
  });

  it('every inclusion proof still verifies with an odd (5) leaf count', () => {
    const root = referenceRoot(leaves5, h2);
    for (let i = 0; i < leaves5.length; i++) {
      expect(verifyInclusion(leaves5[i]!, referenceProof(leaves5, i, h2), root, h2)).toBe(true);
    }
  });

  it('leaf and internal-node domains do not collide (second-preimage separation)', () => {
    const a = leaves5[0]!;
    const b = leaves5[1]!;
    // An internal node carries the DOMAIN_NODE tag → it is NOT a bare pair hash…
    expect(hashNode(a, b, h2)).not.toBe(h2(a, b));
    // …and for identical inner content, leaf-domain and node-domain framings diverge,
    // so a committed leaf value can never equal an internal-node value.
    expect(DOMAIN_LEAF).not.toBe(DOMAIN_NODE);
    const inner = h2(a, b);
    expect(h2(DOMAIN_LEAF, inner)).not.toBe(h2(DOMAIN_NODE, inner));
  });

  it('a leaf commitment carries the leaf domain and never equals a node commitment', () => {
    // Structural second-preimage guarantee: leafHash is DOMAIN_LEAF-framed; every
    // internal node is DOMAIN_NODE-framed. For an attacker to pass an internal node off
    // as a committed leaf, they would need a leaf preimage hashing to a DOMAIN_NODE value
    // — a cross-domain collision. Here we show the two framings are disjoint in practice.
    const leaf = leafHash(mkLeaf(0), h2);
    const node = hashNode(leaves5[1]!, leaves5[2]!, h2);
    expect(leaf).not.toBe(node);
  });
});
