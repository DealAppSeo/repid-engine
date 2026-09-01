/**
 * memory-content-store.ts — the DB-row <-> MemoryEntry boundary for `agent_memory_leaf_content`
 * (backlog item 3, additive migration
 * supabase/migrations/20260901000000_agent_memory_leaf_content.sql).
 *
 * Pure. No I/O, no Supabase client — mirrors memory-root-store.ts's shape for the same reason:
 * a caller fetches rows, this module turns them into checked `MemoryEntry` values without a
 * live database, so the integrity property is testable in isolation.
 *
 * The property this module exists to enforce: content is stored OFF the commitment (this is
 * exactly what makes it fast to fetch), so nothing about the row's own shape prevents a
 * corrupted or tampered `content` column from being handed back as if it were what the tree
 * actually committed to. `contentMatchesValue` is the check every caller MUST run before
 * trusting a row — the same non-negotiable step `memory-root-store.ts`'s `auditStoredCommitment`
 * enforces for roots.
 */
import { encodeEntry, type MemoryEntry } from './proof-carrying-memory';
import { poseidon2LeafHash } from '../zkp/poseidon2-leaf';
import type { LeafHash } from './leanimt-plus';

/** Shape of a row from `agent_memory_leaf_content` (or an equivalent in-memory fixture). */
export interface MemoryContentRow {
  value: string;
  content: string;
  source_id: string;
  source_repid: number;
  hal_verdict: string;
  epoch: number;
}

const dfltLeaf: LeafHash = poseidon2LeafHash;

/** Row -> MemoryEntry. Does NOT check the row against its claimed `value` — see `contentMatchesValue`. */
export function rowToEntry(row: MemoryContentRow): MemoryEntry {
  return { content: row.content, source_id: row.source_id, source_repid: row.source_repid, hal_verdict: row.hal_verdict, epoch: row.epoch };
}

/**
 * Recomputes the leaf commitment from the row's own fields and compares it to `value`.
 * False for a row whose `content` (or any other field) has drifted from what was actually
 * committed — a corrupted row, a bad write, or a value copied from a different entry.
 */
export function contentMatchesValue(row: MemoryContentRow, leafHash: LeafHash = dfltLeaf): boolean {
  return leafHash(encodeEntry(rowToEntry(row))) === row.value;
}

/**
 * Row -> MemoryEntry, throwing if the row fails `contentMatchesValue`. The only entry point a
 * retrieval path should use — returning an unchecked entry defeats the reason this table is
 * content-addressed at all.
 */
export function verifiedEntry(row: MemoryContentRow, leafHash: LeafHash = dfltLeaf): MemoryEntry {
  if (!contentMatchesValue(row, leafHash)) {
    throw new Error(`agent_memory_leaf_content row for value=${row.value} does not hash to its own claimed value`);
  }
  return rowToEntry(row);
}
