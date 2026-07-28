/**
 * leanimt-plus.ts — P1 of PROOF_CARRYING_RETRIEVAL_v0 (spec: living-docs/03_specs).
 * Decision D-094: accumulator = indexed Merkle tree (LeanIMT+ family).
 *
 * This is the reduction-to-practice of the core "current-valid, revocable agent memory"
 * construction: an indexed Merkle tree whose leaves form a sorted linked list of values
 * (value, next), enabling BOTH membership and NON-membership proofs, and PROVABLE RETRACTION
 * (revoke unlinks a value so a subsequent non-membership proof succeeds) — without rewriting
 * history. Poseidon2-backed (BabyBear leaf, D-094 field hold); hash primitives injected so the
 * base tree is swappable (the true LeanIMT no-zero promotion is the production-tree optimization;
 * this reference uses the fork-independent binary-Merkle base from proof-carrying-index (P0) —
 * the novel indexed / non-membership / revocation layer is identical over either base tree).
 *
 * Verifiers are STATELESS pure functions: what a peer / HAL / an on-chain check runs against a
 * committed root. No I/O. Full-rebuild-per-op here favors provable correctness; O(log n)
 * incremental update is the noted production optimization.
 */
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';
import { referenceRoot, referenceProof, verifyInclusion, type Hash2, type ProofStep } from './proof-carrying-index';

export type Hex = string;
export type LeafHash = (commitment: string) => Hex;

/** A linked, indexed leaf: `value` with a pointer to the `next` larger active value (0 = tail). */
export interface IndexedLeaf { value: bigint; next: bigint; tombstoned: boolean; }
export interface InclusionWitness { index: number; leaf: IndexedLeaf; path: ProofStep[]; }
export interface NonMembershipWitness { lowLeaf: InclusionWitness; }

const LEAF_TAG = 'repid.memory.leanimt+.v0';
/** Canonical, domain-separated leaf encoding (tombstone folded in so a retraction changes the digest). */
export function encodeLeaf(l: IndexedLeaf): string {
  return `${LEAF_TAG}|${l.value.toString()}|${l.next.toString()}|${l.tombstoned ? 1 : 0}`;
}

export interface LeanIMTPlusOpts { leafHash?: LeafHash; pairHash?: Hash2; }

export class LeanIMTPlus {
  private leaves: IndexedLeaf[];
  private readonly leafHash: LeafHash;
  private readonly pair: Hash2;

  constructor(opts: LeanIMTPlusOpts = {}) {
    this.leafHash = opts.leafHash ?? poseidon2LeafHash;
    this.pair = opts.pairHash ?? ((a, b) => poseidon2PairHash(a, b));
    // Sentinel at index 0: value 0, next 0 (empty active set). Never tombstoned; the only legal value-0 low leaf.
    this.leaves = [{ value: 0n, next: 0n, tombstoned: false }];
  }

  private digest(l: IndexedLeaf): Hex { return this.leafHash(encodeLeaf(l)); }
  private digests(): Hex[] { return this.leaves.map((l) => this.digest(l)); }
  root(): Hex { return referenceRoot(this.digests(), this.pair); }
  size(): number { return this.leaves.length; }

  /** Active low leaf for v: not tombstoned, value < v, and (next > v OR next == 0 tail). Value-0 only if sentinel. */
  private lowLeafIndex(v: bigint): number {
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (l.tombstoned) continue;
      if (l.value === 0n && i !== 0) continue; // tombstone guard: only the sentinel may be value 0
      if (l.value < v && (l.next > v || l.next === 0n)) return i;
    }
    return -1;
  }
  private activeValueIndex(v: bigint): number {
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (!l.tombstoned && l.value === v) return i;
    }
    return -1;
  }

  /** Insert v (v > 0, not already active), maintaining the sorted linked list. Two leaf writes. */
  insert(v: bigint): void {
    if (v <= 0n) throw new Error('LeanIMTPlus.insert: value must be > 0 (0 reserved for sentinel)');
    if (this.activeValueIndex(v) !== -1) throw new Error(`LeanIMTPlus.insert: value ${v} already active`);
    const li = this.lowLeafIndex(v);
    if (li === -1) throw new Error(`LeanIMTPlus.insert: no low leaf for ${v} (corrupt list)`);
    const low = this.leaves[li]!;
    const inserted: IndexedLeaf = { value: v, next: low.next, tombstoned: false };
    low.next = v;                 // relink predecessor to point at the new value
    this.leaves.push(inserted);   // append the new leaf
  }

  /** Provable retraction: unlink v from the active chain and tombstone its leaf (history preserved). */
  revoke(v: bigint): void {
    // Mirrors insert()'s domain. Without this, revoke(0) matches the SENTINEL (the one active
    // value-0 leaf), tombstones it, and relinks its predecessor onto its own value — a self-loop
    // that freezes the tree: every later insert fails "no low leaf". The sentinel is structural,
    // not a fact, so retracting it is never a meaningful request.
    if (v <= 0n) throw new Error('LeanIMTPlus.revoke: value must be > 0 (0 reserved for sentinel)');
    const vi = this.activeValueIndex(v);
    if (vi === -1) throw new Error(`LeanIMTPlus.revoke: value ${v} not active`);
    let pi = -1;
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i]!;
      if (!l.tombstoned && l.next === v) { pi = i; break; }
    }
    if (pi === -1) throw new Error(`LeanIMTPlus.revoke: no predecessor for ${v}`);
    const vLeaf = this.leaves[vi]!;
    this.leaves[pi]!.next = vLeaf.next; // predecessor skips over v → v now provably absent
    vLeaf.tombstoned = true;            // tombstone (guarded from ever being a low leaf)
    vLeaf.value = 0n; vLeaf.next = 0n;
  }

  private witnessAt(index: number): InclusionWitness {
    return { index, leaf: { ...this.leaves[index]! }, path: referenceProof(this.digests(), index, this.pair) };
  }
  /** Witness that v is currently a member (active). Throws if not active. */
  membershipProof(v: bigint): InclusionWitness {
    const i = this.activeValueIndex(v);
    if (i === -1) throw new Error(`LeanIMTPlus.membershipProof: value ${v} not active`);
    return this.witnessAt(i);
  }
  /** Witness that v is absent (never inserted, or revoked) — via its active low leaf. */
  nonMembershipProof(v: bigint): NonMembershipWitness {
    const li = this.lowLeafIndex(v);
    if (li === -1) throw new Error(`LeanIMTPlus.nonMembershipProof: value ${v} appears present or list corrupt`);
    return { lowLeaf: this.witnessAt(li) };
  }
}

// ── Stateless verifiers (what a peer / HAL / on-chain contract runs against a committed root) ──

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/** v is a current member of the memory committed to `root`. */
export function verifyMembership(v: bigint, w: InclusionWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  if (w.leaf.tombstoned || w.leaf.value !== v) return false;
  return verifyInclusion(leafHash(encodeLeaf(w.leaf)), w.path, root, pair);
}

/** v is provably ABSENT from the memory committed to `root` (never inserted, or revoked). */
export function verifyNonMembership(v: bigint, w: NonMembershipWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  const L = w.lowLeaf.leaf;
  if (L.tombstoned) return false;
  if (L.value === 0n && w.lowLeaf.index !== 0) return false; // tombstone guard
  const ordered = L.value < v && (L.next > v || L.next === 0n);
  if (!ordered) return false;
  return verifyInclusion(leafHash(encodeLeaf(L)), w.lowLeaf.path, root, pair);
}

/** Current-validity = active membership. After revoke(v) this FAILS while non-membership(v) succeeds. */
export function verifyCurrentValidity(v: bigint, w: InclusionWitness, root: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  return verifyMembership(v, w, root, leafHash, pair);
}
