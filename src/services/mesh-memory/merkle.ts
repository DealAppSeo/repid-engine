/**
 * mesh-memory/merkle.ts — a plain binary Merkle tree over the committed index.
 *
 * ┌─ STUB LABEL ──────────────────────────────────────────────────────────────┐
 * │ This is the PROOF-CARRYING-RETRIEVAL *COMMITMENT*. It is a hash commitment, │
 * │ NOT a zero-knowledge proof. What it proves: "the (token → encrypted-        │
 * │ postings) entry the host returned is a committed leaf under root R" — i.e.  │
 * │ INTEGRITY / non-equivocation of the encrypted index. What it does NOT       │
 * │ prove: anything in zero knowledge, nor that the host returned ALL matching  │
 * │ leaves, nor anything about the plaintext.                                   │
 * │                                                                             │
 * │ As of this change the DEFAULT hash is **Poseidon2 over BabyBear** (the      │
 * │ canon impl in `src/zkp/poseidon2-leaf.ts`, backlog 4.0-c, bit-exact vs      │
 * │ Plonky3 0.3.0's PaddingFreeSponge/TruncatedPermutation — ZKP_ARCHITECTURE_  │
 * │ INVARIANTS Invariant 1, one hash/field). Poseidon2 makes this commitment    │
 * │ *ZK-circuit-ready*: a future Plonky3 membership circuit could prove         │
 * │ inclusion under this same root IN ZERO KNOWLEDGE. It does NOT by itself      │
 * │ make retrieval zero-knowledge — that ZK membership circuit does NOT exist    │
 * │ yet (STUB). sha256 is retained ONLY as an explicitly-labeled, non-          │
 * │ aggregation-ready fallback for debugging/interop; it is never the default.  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Second-preimage separation (interior node passed off as a leaf):
 *   - Poseidon2: leaves are a PaddingFreeSponge over UTF-8 bytes; interior nodes
 *     are a TruncatedPermutation compression of two 8-field digests — two
 *     distinct Plonky3 constructions, so leaf and node domains do not collide.
 *     A 'L' prefix on leaf data is kept as belt-and-suspenders.
 *   - sha256: 'L'/'N' one-byte domain prefixes (the classic fix).
 */

import { sha256Hex } from './crypto';
import { poseidon2LeafHash, poseidon2PairHash } from '../../zkp/poseidon2-leaf';

/**
 * Which hash the tree/commitment is built with. Poseidon2 is aggregation/ZK-ready
 * (BabyBear-native, Plonky3-parity); sha256 is a labeled, NON-aggregation fallback.
 */
export type MerkleHashScheme = 'poseidon2' | 'sha256';

/** The default scheme for every mesh-memory commitment. */
export const DEFAULT_SCHEME: MerkleHashScheme = 'poseidon2';

interface HashScheme {
  readonly name: MerkleHashScheme;
  hashLeaf(data: string): string;
  hashNode(left: string, right: string): string;
  empty(): string;
}

const POSEIDON2_SCHEME: HashScheme = {
  name: 'poseidon2',
  // 'L' prefix keeps the belt-and-suspenders leaf/interior domain split.
  hashLeaf: (data) => poseidon2LeafHash('L' + data),
  hashNode: (left, right) => poseidon2PairHash(left, right),
  empty: () => poseidon2LeafHash('EMPTY'),
};

const SHA256_SCHEME: HashScheme = {
  name: 'sha256',
  hashLeaf: (data) => sha256Hex('L' + data),
  hashNode: (left, right) => sha256Hex('N' + left + right),
  empty: () => sha256Hex('EMPTY'),
};

function schemeFor(name: MerkleHashScheme): HashScheme {
  return name === 'sha256' ? SHA256_SCHEME : POSEIDON2_SCHEME;
}

/**
 * The honest label that travels with a serialized proof. Names the scheme AND
 * marks that this is a commitment, not a ZK proof — so no caller can mistake a
 * Poseidon2 Merkle inclusion for a zero-knowledge membership proof.
 */
export type MerkleProofKind =
  | 'merkle-inclusion-poseidon2-commitment'
  | 'merkle-inclusion-sha256-commitment';

function kindFor(name: MerkleHashScheme): MerkleProofKind {
  return name === 'sha256'
    ? 'merkle-inclusion-sha256-commitment'
    : 'merkle-inclusion-poseidon2-commitment';
}

function schemeForKind(kind: MerkleProofKind): HashScheme {
  return kind === 'merkle-inclusion-sha256-commitment' ? SHA256_SCHEME : POSEIDON2_SCHEME;
}

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
   * Honest, self-describing label so (a) no caller mistakes this for a ZK proof
   * and (b) the verifier knows which hash to recompute with. Present in the
   * serialized proof so it travels with the artifact.
   */
  kind: MerkleProofKind;
}

/**
 * A Merkle tree over an ordered list of leaf *strings*. Odd nodes at a level are
 * promoted (duplicated up) rather than hashed against a duplicate of themselves.
 * Defaults to Poseidon2 (aggregation/ZK-ready); pass 'sha256' only for the
 * labeled fallback.
 */
export class MerkleTree {
  readonly leaves: string[];
  readonly scheme: MerkleHashScheme;
  private hs: HashScheme;
  private levels: string[][];

  /**
   * @param leafData ordered raw leaf strings (will be leaf-hashed internally)
   * @param scheme   hash scheme (default Poseidon2)
   */
  constructor(leafData: string[], scheme: MerkleHashScheme = DEFAULT_SCHEME) {
    this.scheme = scheme;
    this.hs = schemeFor(scheme);
    if (leafData.length === 0) {
      // Empty tree: a well-defined empty root so an empty cell still commits.
      this.leaves = [];
      this.levels = [[this.hs.empty()]];
      return;
    }
    this.leaves = leafData.map((d) => this.hs.hashLeaf(d));
    this.levels = [this.leaves];
    let current = this.leaves;
    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = i + 1 < current.length ? current[i + 1]! : undefined;
        next.push(right === undefined ? left : this.hs.hashNode(left, right));
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
      kind: kindFor(this.scheme),
    };
  }
}

/**
 * Hash a raw leaf string the same way the tree does (for building a proof over
 * known data). Defaults to Poseidon2; pass 'sha256' for the fallback.
 */
export function leafHash(data: string, scheme: MerkleHashScheme = DEFAULT_SCHEME): string {
  return schemeFor(scheme).hashLeaf(data);
}

/**
 * Verify an inclusion proof against an expected root. Recomputes the root from
 * the leaf + path using the scheme named in `proof.kind`, and compares. Returns
 * false on any mismatch. The proof is self-describing, so a sha256 fallback proof
 * and a Poseidon2 proof each verify with their own hash — no ambient scheme flag.
 */
export function verifyProof(proof: MerkleProof, expectedRoot: string): boolean {
  if (proof.root !== expectedRoot) return false;
  const hs = schemeForKind(proof.kind);
  let acc = proof.leaf;
  for (const step of proof.path) {
    acc = step.siblingIsRight ? hs.hashNode(acc, step.sibling) : hs.hashNode(step.sibling, acc);
  }
  return acc === expectedRoot;
}
