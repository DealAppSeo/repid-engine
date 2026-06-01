/**
 * Hash-AGNOSTIC Merkle root + inclusion proof (sprint 2026-05-29, continues PR #73).
 *
 * WHY hash-agnostic: the dual-prover migration (sha256 → Poseidon2 / keccak split,
 * ZKP_ARCHITECTURE_INVARIANTS Invariant 1) is NOT yet applied by Sean. The epoch
 * root must compute correctly regardless of which hash family wins. The tree
 * shape (Bitcoin-style: odd level → duplicate last) is identical across schemes;
 * only the leaf/pair hash differs, and it is INJECTED here.
 *
 * Schemes provided:
 *   - keccak256 (default; matches PR #73 + the live audit-merkle-anchor, EAS-anchorable on Base)
 *   - sha256    (matches the current commitment family; drop-in if the chain side moves to sha256)
 *   - poseidon2 (FLAGGED placeholder — throws until the Plonky3-native prover lands; no mock [rule:7])
 *
 * MIGRATION SWAP POINT: when Sean applies the dual-prover migration, change the
 * default scheme name passed by the epoch anchor (one argument) — nothing else
 * in the tree logic changes. The poseidon2 entry is where the real field hash
 * gets wired.
 */
import { keccak256, sha256 as ethersSha256, getBytes, concat, toUtf8Bytes } from 'ethers';

export type LeafHashFn = (commitment: string) => string;
export type PairHashFn = (aHex: string, bHex: string) => string;

export interface HashScheme {
  name: string;
  leaf: LeafHashFn;
  pair: PairHashFn;
}

const keccakScheme: HashScheme = {
  name: 'keccak256',
  leaf: (c) => keccak256(toUtf8Bytes(c)),
  pair: (a, b) => keccak256(concat([getBytes(a), getBytes(b)])),
};

const sha256Scheme: HashScheme = {
  name: 'sha256',
  leaf: (c) => ethersSha256(toUtf8Bytes(c)),
  pair: (a, b) => ethersSha256(concat([getBytes(a), getBytes(b)])),
};

// FLAGGED: Poseidon2 over a Plonky3-native field is the eventual leaf/pair hash
// (Invariant 1). Wiring it requires the migrated prover; until then this throws
// rather than silently substituting a different hash (no mock-as-real).
const poseidon2Scheme: HashScheme = {
  name: 'poseidon2',
  leaf: () => { throw new Error('[merkle-root] poseidon2 scheme not available until the dual-prover migration lands'); },
  pair: () => { throw new Error('[merkle-root] poseidon2 scheme not available until the dual-prover migration lands'); },
};

export const HASH_SCHEMES: Record<string, HashScheme> = {
  keccak256: keccakScheme,
  sha256: sha256Scheme,
  poseidon2: poseidon2Scheme,
};

export const DEFAULT_HASH_SCHEME = 'keccak256';

export function getHashScheme(name: string = DEFAULT_HASH_SCHEME): HashScheme {
  const s = HASH_SCHEMES[name];
  if (!s) throw new Error(`[merkle-root] unknown hash scheme '${name}' (have: ${Object.keys(HASH_SCHEMES).join(', ')})`);
  return s;
}

export interface InclusionProof {
  leaf: string;
  index: number;
  siblings: Array<{ hash: string; position: 'left' | 'right' }>;
  root: string;
  scheme: string;
}

/** Bitcoin-style root over pre-hashed leaves with an injected pair hash. */
export function buildRoot(leaves: string[], pair: PairHashFn): string {
  if (leaves.length === 0) throw new Error('[merkle-root] empty leaf set');
  if (leaves.length === 1) return leaves[0]!;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // odd → duplicate
      next.push(pair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** Inclusion proof for `index`, pairing identical to buildRoot. */
export function buildInclusion(leaves: string[], index: number, scheme: HashScheme): InclusionProof {
  if (leaves.length === 0) throw new Error('[merkle-root] empty leaf set');
  if (index < 0 || index >= leaves.length) throw new Error(`[merkle-root] index ${index} out of range`);
  const siblings: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(scheme.pair(left, right));
    }
    if (idx % 2 === 0) {
      const rightIdx = idx + 1 < level.length ? idx + 1 : idx;
      siblings.push({ hash: level[rightIdx]!, position: 'right' });
    } else {
      siblings.push({ hash: level[idx - 1]!, position: 'left' });
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return { leaf: leaves[index]!, index, siblings, root: level[0]!, scheme: scheme.name };
}

/** Recompute the root from a leaf + siblings under the proof's scheme. */
export function verifyInclusion(proof: InclusionProof): boolean {
  const scheme = getHashScheme(proof.scheme);
  let acc = proof.leaf;
  for (const s of proof.siblings) {
    acc = s.position === 'left' ? scheme.pair(s.hash, acc) : scheme.pair(acc, s.hash);
  }
  return acc.toLowerCase() === proof.root.toLowerCase();
}

/** Convenience: hash commitments to leaves + build the root under a named scheme. */
export function rootFromCommitments(commitments: string[], schemeName: string = DEFAULT_HASH_SCHEME): { root: string; leaves: string[]; scheme: string } {
  const scheme = getHashScheme(schemeName);
  const leaves = commitments.map(scheme.leaf);
  return { root: buildRoot(leaves, scheme.pair), leaves, scheme: scheme.name };
}
