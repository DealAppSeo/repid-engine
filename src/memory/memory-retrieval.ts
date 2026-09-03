/**
 * memory-retrieval.ts — backlog item 3 (P2 retrieval API): the primitive a caller hands
 * fetched rows to, and gets back verified `MemoryEntry` values with witnesses, closing the
 * gap proof-carrying-memory.ts's header names — content lives off-index in an in-process
 * `Map` today, so nothing outside a single live process can answer "what does this leaf
 * actually say". `memory-root-store.ts` (roots) and `memory-content-store.ts` (content) each
 * check their own half; this module is the bridge that runs both checks before handing
 * anything back.
 *
 * Pure — no I/O, no Supabase client — mirrors those two modules' own shape so the
 * acceptance test (a live prover built from stored rows, content handed back with a
 * witness) is checkable without a live database.
 */
import { hydrateTree, rootMatchesStored, type MemoryLeafRow } from './memory-root-store';
import { verifiedEntry, type MemoryContentRow } from './memory-content-store';
import type { MemoryEntry } from './proof-carrying-memory';
import type { Hex, InclusionWitness, LeafHash } from './leanimt-plus';
import type { Hash2 } from './proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';

export interface RetrievedMemoryEntry {
  entry: MemoryEntry;
  value: string;
  /** Witness that `value` is a current member of `root`. Also the current-validity proof — see leanimt-plus.ts: verifyCurrentValidity === verifyMembership. */
  inclusionProof: InclusionWitness;
  currentValidityProof: InclusionWitness;
}

export interface VerifiedRetrieval {
  root: Hex;
  entries: RetrievedMemoryEntry[];
}

const dfltLeaf: LeafHash = poseidon2LeafHash;
const dfltPair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/**
 * Refuses (throws) if the fetched leaf rows don't recompute to the caller-supplied stored
 * root — never producing a witness against a root the rows themselves don't support, the
 * same non-negotiable check `memory-root-store.ts`'s `auditStoredCommitment` enforces for a
 * root alone. A content row that fails `contentMatchesValue` (corrupted, tampered, or copied
 * from a different entry) is DROPPED, not surfaced — it is not the caller's fault to abstain
 * over, but it must never be handed back as if it were trusted. A content row whose `value`
 * is not (or no longer) an active member of the hydrated tree — revoked, or simply absent
 * from this epoch's leaf set — is dropped the same way.
 */
export function retrieveVerifiedMemory(
  leafRows: MemoryLeafRow[],
  contentRows: MemoryContentRow[],
  storedRoot: Hex,
  leafHash: LeafHash = dfltLeaf,
  pair: Hash2 = dfltPair,
): VerifiedRetrieval {
  if (!rootMatchesStored(leafRows, storedRoot, leafHash, pair)) {
    throw new Error('retrieveVerifiedMemory: fetched leaf rows do not recompute to the stored root');
  }
  const tree = hydrateTree(leafRows, leafHash, pair);
  const entries: RetrievedMemoryEntry[] = [];
  for (const row of contentRows) {
    let entry: MemoryEntry;
    try {
      entry = verifiedEntry(row, leafHash);
    } catch {
      continue;
    }
    let witness: InclusionWitness;
    try {
      witness = tree.membershipProof(BigInt(row.value));
    } catch {
      continue;
    }
    entries.push({ entry, value: row.value, inclusionProof: witness, currentValidityProof: witness });
  }
  return { root: storedRoot, entries };
}
