/**
 * proof-carrying-index.ts — P0 of PROOF_CARRYING_RETRIEVAL_v0
 * (E:\dev\living-docs\03_specs\PROOF_CARRYING_RETRIEVAL_v0.md).
 *
 * Fork-INDEPENDENT core: the memory-leaf schema + Merkle inclusion VERIFY, plus a
 * reference binary-Merkle build for tests/demo. `hash2` is INJECTED, so this is
 * testable today with a mock and swaps to the Poseidon2 leaf (backlog 4.0 line,
 * PRs #195/#196/#197) with ZERO changes here.
 *
 * NOT in this file (deliberately): the production append-only accumulator with
 * revocation. That is P1 and is GATED on the Grok-reviewed accumulator fork
 * (indexed Merkle tree vs MMR-with-tombstones) — see spec §5/§9. The path-folding
 * in verifyInclusion() is identical for either fork, so P0 is safe to build now.
 *
 * ## Merkle hygiene (hardened 2026-07-27 — Patent #1)
 * Two standard Merkle weaknesses are closed here so the committed root is a sound
 * cryptographic commitment (not merely a hash chain):
 *
 *   1. DOMAIN SEPARATION (second-preimage resistance, RFC-6962 style). A leaf digest
 *      and an internal-node digest are computed under DISTINCT domain tags
 *      (`DOMAIN_LEAF` vs `DOMAIN_NODE`). Without this, an attacker who controls a
 *      leaf's content could set that leaf equal to an internal-node value and present
 *      a subtree as if it were a single committed leaf (the classic second-preimage
 *      attack). With disjoint domains, a leaf value can never coincide with a node
 *      value except by breaking `hash2`.
 *
 *   2. NON-MALLEABLE ODD-NODE HANDLING (closes CVE-2012-2459). The old reference
 *      build DUPLICATED a lone/odd node (`hash2(x, x)`) up a level, which makes a tree
 *      over `[…, x]` produce the SAME root as a tree over `[…, x, x]` — two distinct
 *      leaf sets, one root, a forgeable inclusion. Instead a lone node is PROMOTED
 *      UNCHANGED to the next level (LeanIMT-style). No duplication ⇒ no such collision.
 *
 * The domain tags are encoded as canonical BabyBear digests (`0x`+64hex, each 32-bit
 * limb < p) so the injected `hash2` seam works unchanged for BOTH the sha256 mock and
 * the production `poseidon2PairHash` (which requires canonical-digest inputs).
 * `verifyInclusion` folds with the SAME node hashing as the builders, so it stays
 * fork-agnostic and consistent with `referenceRoot` / `referenceProof`.
 */

/** Provenance bound into every leaf — this is what makes the index reputation-weighted. */
export interface MemoryProvenance {
  source_id: string;   // who produced/attested the entry
  source_repid: number; // RepID of the source at commit time
  hal_verdict: string; // HAL decision on the entry (clean|flagged|vetoed|…)
  timestamp: number;   // unix ms
  epoch: number;       // commitment epoch
}

export interface MemoryLeaf {
  content_hash: string; // hash of the memory content (content itself lives off-index)
  provenance: MemoryProvenance;
}

/** One step of a Merkle inclusion path. */
export interface ProofStep {
  sibling: string;
  siblingOnLeft: boolean; // true → sibling is the LEFT input to hash2 at this level
}

/** Injected 2-to-1 hash. Mock (sha256) in tests today → Poseidon2 leaf once merged. */
export type Hash2 = (a: string, b: string) => string;

/**
 * Domain-separation tags (RFC-6962-style). LEAF-domain digests and NODE-domain digests
 * are disjoint, so an internal node can never be mistaken for a committed leaf.
 *
 * Encoded as canonical BabyBear digests (`0x`+64hex, every 32-bit limb < p ≈ 0x78000001)
 * so they are valid inputs to BOTH the sha256 mock and `poseidon2PairHash` (whose
 * `hexToFields` rejects non-canonical limbs). Distinct in their low limb (…01 vs …02).
 */
export const DOMAIN_LEAF = '0x' + '00000000'.repeat(7) + '00000001';
export const DOMAIN_NODE = '0x' + '00000000'.repeat(7) + '00000002';

/**
 * Internal-node hash: `hash2(DOMAIN_NODE, hash2(l, r))`. The DOMAIN_NODE prefix is what
 * separates node digests from leaf digests (second-preimage resistance). Order-sensitive
 * in (l, r) — Merkle position-binding is preserved because `hash2(l, r) ≠ hash2(r, l)`.
 */
export function hashNode(l: string, r: string, hash2: Hash2): string {
  return hash2(DOMAIN_NODE, hash2(l, r));
}

/** Left-associative fold of field strings into one hash. */
export function foldHash(items: string[], hash2: Hash2): string {
  if (items.length === 0) throw new Error('foldHash: empty input');
  let acc = items[0]!;
  for (let i = 1; i < items.length; i++) acc = hash2(acc, items[i]!);
  return acc;
}

/** Deterministic hash of the provenance record. */
export function provenanceHash(p: MemoryProvenance, hash2: Hash2): string {
  return foldHash(
    [p.source_id, String(p.source_repid), p.hal_verdict, String(p.timestamp), String(p.epoch)],
    hash2,
  );
}

/**
 * The leaf commitment: `hash2(DOMAIN_LEAF, hash2(content_hash, provenanceHash))`.
 * Provenance-sensitive by construction AND leaf-domain-tagged, so a committed leaf can
 * never collide with an internal node (which carries DOMAIN_NODE).
 */
export function leafHash(leaf: MemoryLeaf, hash2: Hash2): string {
  return hash2(DOMAIN_LEAF, hash2(leaf.content_hash, provenanceHash(leaf.provenance, hash2)));
}

/**
 * Verify a Merkle inclusion proof: fold `leaf` up the `path` and compare to `root`.
 * Uses the domain-separated node hash (`hashNode`), so it is consistent with
 * `referenceRoot` / `referenceProof` and remains fork-independent (the folding is
 * identical for an MMR or an indexed Merkle tree). Returns true iff the leaf provably
 * belongs to the committed root.
 */
export function verifyInclusion(leaf: string, path: ProofStep[], root: string, hash2: Hash2): boolean {
  let acc = leaf;
  for (const step of path) {
    acc = step.siblingOnLeft ? hashNode(step.sibling, acc, hash2) : hashNode(acc, step.sibling, hash2);
  }
  return acc === root;
}

/** Build one level up: pair adjacent nodes; PROMOTE a lone trailing node UNCHANGED. */
function buildLevel(level: string[], hash2: Hash2): string[] {
  const next: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    if (i + 1 < level.length) {
      next.push(hashNode(level[i]!, level[i + 1]!, hash2));
    } else {
      next.push(level[i]!); // lone odd node promoted as-is — no self-hash (closes CVE-2012-2459)
    }
  }
  return next;
}

/**
 * P0 REFERENCE binary Merkle root. For tests/demo and a first inclusion-proof API —
 * NOT the production accumulator (that is P1, pending the Grok accumulator fork).
 * Domain-separated node hashing + LeanIMT-style odd-node promotion (see file header).
 */
export function referenceRoot(leaves: string[], hash2: Hash2): string {
  if (leaves.length === 0) throw new Error('referenceRoot: no leaves');
  let level = leaves.slice();
  while (level.length > 1) level = buildLevel(level, hash2);
  return level[0]!;
}

/** Inclusion path for the leaf at `index` in the P0 reference tree. */
export function referenceProof(leaves: string[], index: number, hash2: Hash2): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error('referenceProof: index out of range');
  const path: ProofStep[] = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    if (idx % 2 === 1) {
      // right child — sibling is the left neighbor
      path.push({ sibling: level[idx - 1]!, siblingOnLeft: true });
    } else if (idx + 1 < level.length) {
      // left child with a real right neighbor
      path.push({ sibling: level[idx + 1]!, siblingOnLeft: false });
    }
    // else: lone trailing node promoted unchanged — no hash at this level, no proof step
    level = buildLevel(level, hash2);
    idx = Math.floor(idx / 2);
  }
  return path;
}
