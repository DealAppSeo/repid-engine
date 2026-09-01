/**
 * memory-root-store.ts — the DB-row <-> IndexedLeaf boundary for `agent_memory_leaves` /
 * `agent_memory_roots` (backlog item 5, additive migration
 * supabase/migrations/20260828000000_agent_memory_leaves_and_roots.sql).
 *
 * Pure. No I/O, no Supabase client — this is what a caller runs AFTER it has fetched rows,
 * so the acceptance test ("append -> root deterministic; recompute matches") is checkable
 * without a live database. Row order is NOT assumed authoritative: rows are sorted by
 * `leaf_index` before hashing, because `leaf_index` is bookkeeping (leanimt-plus.ts's own
 * header: the index is advisory and unauthenticated) but the ROOT still depends on leaf
 * POSITION, so the position used for hashing must be fixed by something other than
 * whatever order a query happens to return.
 */
import { auditCommitment, encodeLeaf, LeanIMTPlus, type CommitmentAudit, type Hex, type IndexedLeaf, type LeafHash } from './leanimt-plus';
import { referenceRoot, type Hash2 } from './proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';

/** Shape of a row from `agent_memory_leaves` (or an equivalent in-memory fixture). */
export interface MemoryLeafRow {
  leaf_index: number;
  value: string;
  next: string;
  tombstoned: boolean;
}

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/** Row -> IndexedLeaf. Throws on a non-numeric value/next rather than silently coercing to 0n. */
export function rowToLeaf(row: MemoryLeafRow): IndexedLeaf {
  return { value: BigInt(row.value), next: BigInt(row.next), tombstoned: row.tombstoned };
}

/** Sort by `leaf_index` (position is what the root binds; the DB read order is not assumed to match). */
function orderedLeaves(rows: MemoryLeafRow[]): IndexedLeaf[] {
  return [...rows].sort((a, b) => a.leaf_index - b.leaf_index).map(rowToLeaf);
}

/** Recompute the root a set of stored leaf rows commits to. Deterministic: same rows, any input order, same root. */
export function recomputeRoot(rows: MemoryLeafRow[], leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): Hex {
  const leaves = orderedLeaves(rows);
  return referenceRoot(leaves.map((l) => leafHash(encodeLeaf(l))), pair);
}

/** Does this row set's recomputed root match a stored `agent_memory_roots.root`? */
export function rootMatchesStored(rows: MemoryLeafRow[], storedRoot: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): boolean {
  return recomputeRoot(rows, leafHash, pair) === storedRoot;
}

/** Whole-commitment audit (leanimt-plus.ts scope 2) over a fetched row set, against a stored root. */
export function auditStoredCommitment(rows: MemoryLeafRow[], storedRoot: Hex, leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): CommitmentAudit {
  return auditCommitment(orderedLeaves(rows), storedRoot, leafHash, pair);
}

/**
 * The bridge item 3 (P2 retrieval API) has been missing: a fetched row set in, a live tree able to
 * produce membership/non-membership witnesses out. `recomputeRoot`/`auditStoredCommitment` above
 * can only check a root, not hand back a prover. Position (leaf_index) is preserved via the same
 * `orderedLeaves` sort every other function in this file already uses, so a hydrated tree's root
 * matches what `recomputeRoot` on the same rows would compute.
 */
export function hydrateTree(rows: MemoryLeafRow[], leafHash: LeafHash = dfltLeaf, pair: Hash2 = dfltPair): LeanIMTPlus {
  return LeanIMTPlus.fromLeaves(orderedLeaves(rows), { leafHash, pairHash: pair });
}
