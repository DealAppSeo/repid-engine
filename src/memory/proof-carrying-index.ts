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

/** The leaf commitment: hash2(content_hash, provenanceHash). Provenance-sensitive by construction. */
export function leafHash(leaf: MemoryLeaf, hash2: Hash2): string {
  return hash2(leaf.content_hash, provenanceHash(leaf.provenance, hash2));
}

/**
 * Verify a Merkle inclusion proof: fold `leaf` up the `path` and compare to `root`.
 * Fork-independent — the folding is identical for an MMR or an indexed Merkle tree.
 * Returns true iff the leaf provably belongs to the committed root.
 */
export function verifyInclusion(leaf: string, path: ProofStep[], root: string, hash2: Hash2): boolean {
  let acc = leaf;
  for (const step of path) {
    acc = step.siblingOnLeft ? hash2(step.sibling, acc) : hash2(acc, step.sibling);
  }
  return acc === root;
}

/**
 * P0 REFERENCE binary Merkle root (odd node duplicated). For tests/demo and a
 * first inclusion-proof API — NOT the production accumulator (that is P1, pending
 * the Grok accumulator fork). Kept minimal and obviously-correct.
 */
export function referenceRoot(leaves: string[], hash2: Hash2): string {
  if (leaves.length === 0) throw new Error('referenceRoot: no leaves');
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = i + 1 < level.length ? level[i + 1]! : level[i]!;
      next.push(hash2(l, r));
    }
    level = next;
  }
  return level[0]!;
}

/** Inclusion path for the leaf at `index` in the P0 reference tree. */
export function referenceProof(leaves: string[], index: number, hash2: Hash2): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error('referenceProof: index out of range');
  const path: ProofStep[] = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : (idx + 1 < level.length ? idx + 1 : idx);
    path.push({ sibling: level[sibIdx]!, siblingOnLeft: isRight });
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = i + 1 < level.length ? level[i + 1]! : level[i]!;
      next.push(hash2(l, r));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}
