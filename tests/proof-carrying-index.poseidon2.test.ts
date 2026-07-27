/**
 * P0 wired to the REAL BabyBear Poseidon2 leaf (merged #195/#196/#197).
 * Proves the fork-independent Merkle core (referenceRoot / referenceProof / verifyInclusion)
 * is correct under the PRODUCTION hash — not just the sha256 mock.
 *
 * Poseidon2 is two-mode: poseidon2LeafHash = sponge (arbitrary entry -> 0x+64hex digest) for
 * LEAVES; poseidon2PairHash = compress (two digests -> digest) for TREE NODES. The injected
 * Hash2 seam carries the pair (compress) hash; leaves are pre-digested via the sponge.
 * NOTE (P0.1 follow-up): the convenience `leafHash(leaf, hash2)` in the module folds provenance
 * through a single hash2 — fine for the mock, but the production leaf commitment should use the
 * sponge (poseidon2LeafHash over a canonical entry), as done here.
 */
import { verifyInclusion, referenceRoot, referenceProof, type Hash2 } from '../src/memory/proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';

const pair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/** Production-shaped leaf digest: canonical entry (content + reputation-weighted provenance) -> sponge digest. */
function leafDigest(i: number): string {
  return poseidon2LeafHash(JSON.stringify({
    content_hash: `content-${i}`, source_id: `agent-${i}`, source_repid: 1000 + i, hal_verdict: 'clean', epoch: 1,
  }));
}

describe('proof-carrying-index P0 — REAL BabyBear Poseidon2 (merged #195-197)', () => {
  const leaves = Array.from({ length: 6 }, (_, i) => leafDigest(i));
  const root = referenceRoot(leaves, pair);

  it('every inclusion proof verifies under the real Poseidon2 pair hash', () => {
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyInclusion(leaves[i]!, referenceProof(leaves, i, pair), root, pair)).toBe(true);
    }
  });

  it('a leaf never committed fails under the real hash', () => {
    const forged = poseidon2LeafHash(JSON.stringify({ content_hash: 'content-999' }));
    expect(verifyInclusion(forged, referenceProof(leaves, 0, pair), root, pair)).toBe(false);
  });

  it('sponge leaf digests are canonical 0x+64hex and provenance-sensitive', () => {
    expect(leaves[0]).toMatch(/^0x[0-9a-f]{64}$/);
    const a = poseidon2LeafHash(JSON.stringify({ content_hash: 'x', source_repid: 1000 }));
    const b = poseidon2LeafHash(JSON.stringify({ content_hash: 'x', source_repid: 2000 }));
    expect(a).not.toBe(b); // changing provenance changes the committed leaf
  });

  it('pair hash is order-sensitive (Merkle position-binding)', () => {
    expect(pair(leaves[0]!, leaves[1]!)).not.toBe(pair(leaves[1]!, leaves[0]!));
  });
});
