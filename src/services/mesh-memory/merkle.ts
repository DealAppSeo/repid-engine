/**
 * mesh-memory/merkle.ts — a plain binary Merkle tree over the committed index.
 *
 * ┌─ STUB LABEL ──────────────────────────────────────────────────────────────┐
 * │ This is the PROOF-CARRYING-RETRIEVAL *STUB*. It is a hash commitment, NOT a │
 * │ zero-knowledge proof. What it proves: "the (token → encrypted-postings)     │
 * │ entry the host returned is a committed leaf under root R" — i.e. INTEGRITY  │
 * │ / non-equivocation of the encrypted index. What it does NOT prove: anything │
 * │ in zero knowledge, nor that the host returned ALL matching leaves, nor      │
 * │ anything about the plaintext. The future ZK version (Poseidon2 leaves +     │
 * │ Plonky3 aggregation, per ZKP_ARCHITECTURE_INVARIANTS) replaces this.        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Leaf/interior domain separation ('L'/'N' prefixes) blocks the classic
 * second-preimage attack where an interior node is passed off as a leaf.
 */

import { sha256Hex } from './crypto';

export interface MerkleProofStep {
  /** sibling hash (hex) */
  sibling: string;
  /** true if the sibling sits on the right of the current node */
  siblingIsRight: boolean;
}

export interface MerkleProof {
  /** hex hash of the leaf being proven */
  leaf: string;
  /** the leaf's index in the original ordered leaf list */
  index: number;
  /** total number of leaves committed */
  leafCount: number;
  path: MerkleProofStep[];
  /** the root this proof is against */
  root: string;
  /**
   * Honest label so no caller can mistake this for a ZK proof. Present in the
   * serialized proof so it travels with the artifact.
   */
  kind: 'merkle-inclusion-stub';
}

function hashLeaf(data: string): string {
  return sha256Hex('L' + data);
}

function hashNode(left: string, right: string): string {
  return sha256Hex('N' + left + right);
}

/**
 * A Merkle tree over an ordered list of leaf *hashes* (already hashed with
 * hashLeaf by the builder). Odd nodes at a level are promoted (duplicated up)
 * rather than hashed against a duplicate of themselves.
 */
export class MerkleTree {
  readonly leaves: string[];
  private levels: string[][];

  /** @param leafData ordered raw leaf strings (will be leaf-hashed internally) */
  constructor(leafData: string[]) {
    if (leafData.length === 0) {
      // Empty tree: a well-defined empty root so an empty cell still commits.
      this.leaves = [];
      this.levels = [[sha256Hex('EMPTY')]];
      return;
    }
    this.leaves = leafData.map(hashLeaf);
    this.levels = [this.leaves];
    let current = this.leaves;
    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = i + 1 < current.length ? current[i + 1]! : undefined;
        next.push(right === undefined ? left : hashNode(left, right));
      }
      this.levels.push(next);
      current = next;
    }
  }

  root(): string {
    const top = this.levels[this.levels.length - 1]!;
    return top[0]!;
  }

  /** Build an inclusion proof for the leaf at `index`. */
  proof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`merkle: leaf index ${index} out of range (0..${this.leaves.length - 1})`);
    }
    const path: MerkleProofStep[] = [];
    let idx = index;
    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level]!;
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;
      if (siblingIdx < nodes.length) {
        path.push({ sibling: nodes[siblingIdx]!, siblingIsRight: !isRightNode });
      }
      // else: promoted (no sibling) — nothing added, node carries up unchanged.
      idx = Math.floor(idx / 2);
    }
    return {
      leaf: this.leaves[index]!,
      index,
      leafCount: this.leaves.length,
      path,
      root: this.root(),
      kind: 'merkle-inclusion-stub',
    };
  }
}

/** Hash a raw leaf string the same way the tree does (for building a proof over known data). */
export function leafHash(data: string): string {
  return hashLeaf(data);
}

/**
 * Verify an inclusion proof against an expected root. Recomputes the root from
 * the leaf + path and compares. Returns false on any mismatch.
 */
export function verifyProof(proof: MerkleProof, expectedRoot: string): boolean {
  if (proof.root !== expectedRoot) return false;
  let acc = proof.leaf;
  for (const step of proof.path) {
    acc = step.siblingIsRight ? hashNode(acc, step.sibling) : hashNode(step.sibling, acc);
  }
  return acc === expectedRoot;
}
