/**
 * repid-snapshot.ts — a per-agent, per-epoch RepID SNAPSHOT: a Merkle root over the agent's settled
 * events, a non-zero `repidSnapshot` value, and an inclusion path from one settled event to the root.
 *
 * Why: the tri-eval (#16) found every anchor written with `repidSnapshot = 0` and no inclusion path, so an
 * anchored root said nothing about a score. Here the score is INSIDE a leaf, and the anchored
 * `repidSnapshot` is the score of the latest settled leaf, so a reader holding (root, leaf, path) can check
 * both that the event is committed and that the anchored number is the one the event carries.
 *
 * Pure. No I/O. The tree is the existing P0 reference tree (`referenceRoot` / `referenceProof` /
 * `verifyInclusion`: domain-separated nodes, odd node promoted, never duplicated) over the audited
 * Poseidon2 primitives. Nothing new is stored: a snapshot is what a caller computes from rows it already
 * has (the existing memory store `agent_memory_leaves` / `agent_memory_roots`).
 *
 * WHAT IT DOES NOT PROVE: that the score is correct, or that the leaf set is complete. Anchoring makes the
 * snapshot timestamped and non-repudiable, not true.
 */
import { DOMAIN_LEAF, referenceProof, referenceRoot, verifyInclusion, type Hash2, type ProofStep } from './proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../zkp/poseidon2-leaf';

export const REPID_SNAPSHOT_LEAF_TAG = 'hyperdag/repid/snapshot/leaf/v1';
export const REPID_SNAPSHOT_PROOF_TYPE = 'REPID_SNAPSHOT_ROOT';

/**
 * One settled event, as the settlement lane will hand it over. Join key for the sibling lane's fixture:
 * `contractId` (service_contracts.id) + `agentId` (repid_agents.id) + `scoreAfter` (current_repid after the
 * settlement's score event). Fields are strings/ints so the canonical leaf text is unambiguous.
 */
export interface SettledEvent {
  contractId: string;
  agentId: string;
  /** current_repid after this settlement. Must be a positive integer: a zero snapshot is the defect being fixed. */
  scoreAfter: number;
  /** settlement time, unix ms */
  settledAt: number;
}

export interface RepidSnapshot {
  snapshotId: string;
  agentId: string;
  epoch: number;
  root: string;
  leafCount: number;
  /** score of the latest settled event in the epoch — the value the anchor carries as `repidSnapshot`. */
  repidSnapshot: number;
  events: SettledEvent[];
  leafHashes: string[];
}

export interface SnapshotInclusionProof {
  root: string;
  leaf: SettledEvent & { epoch: number };
  path: ProofStep[];
}

const pair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/** Canonical leaf text. Fixed field order; `|` cannot appear in an integer and is refused in ids. */
export function snapshotLeafText(e: SettledEvent, epoch: number): string {
  for (const v of [e.contractId, e.agentId]) {
    if (typeof v !== 'string' || v === '' || v.includes('|')) throw new Error(`invalid id in settled event: '${v}'`);
  }
  if (!Number.isSafeInteger(e.scoreAfter) || e.scoreAfter <= 0) throw new Error(`scoreAfter must be a positive integer, got ${e.scoreAfter}`);
  if (!Number.isSafeInteger(e.settledAt) || e.settledAt < 0) throw new Error(`settledAt must be unix ms, got ${e.settledAt}`);
  return [REPID_SNAPSHOT_LEAF_TAG, epoch, e.agentId, e.contractId, e.scoreAfter, e.settledAt].join('|');
}

/** Leaf hash = hash2(DOMAIN_LEAF, Sponge(text)) — leaf-domain tagged, so no internal node can pose as a leaf. */
export function snapshotLeafHash(e: SettledEvent, epoch: number): string {
  return pair(DOMAIN_LEAF, poseidon2LeafHash(snapshotLeafText(e, epoch)));
}

/** Build the snapshot for one agent's settled events in one epoch. Events are ordered by (settledAt, contractId). */
export function buildRepidSnapshot(agentId: string, epoch: number, events: SettledEvent[]): RepidSnapshot {
  if (events.length === 0) throw new Error('a snapshot needs at least one settled event');
  if (events.some((e) => e.agentId !== agentId)) throw new Error('every event in a snapshot must belong to its agent');
  const ordered = [...events].sort((a, b) => a.settledAt - b.settledAt || (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
  const leafHashes = ordered.map((e) => snapshotLeafHash(e, epoch));
  const root = referenceRoot(leafHashes, pair);
  return {
    snapshotId: `${agentId}:${epoch}:${root.slice(2, 18)}`,
    agentId, epoch, root, leafCount: ordered.length,
    repidSnapshot: ordered[ordered.length - 1]!.scoreAfter,
    events: ordered, leafHashes,
  };
}

/** Inclusion proof for the settled event with `contractId`. */
export function proveSettled(s: RepidSnapshot, contractId: string): SnapshotInclusionProof {
  const i = s.events.findIndex((e) => e.contractId === contractId);
  if (i < 0) throw new Error(`contract ${contractId} is not in snapshot ${s.snapshotId}`);
  return { root: s.root, leaf: { ...s.events[i]!, epoch: s.epoch }, path: referenceProof(s.leafHashes, i, pair) };
}

export interface SnapshotVerdict {
  ok: boolean;
  leafHash: string | null;
  /** the score the verified leaf carries — compare against the anchor's `repidSnapshot`. */
  score: number | null;
  reason?: string;
}

/** Verify from (root, leaf, path) alone. Total: a malformed input is `ok:false` with a reason, never a throw. */
export function verifySnapshotInclusion(p: SnapshotInclusionProof): SnapshotVerdict {
  try {
    const leafHash = snapshotLeafHash(p.leaf, p.leaf.epoch);
    const ok = verifyInclusion(leafHash, p.path, p.root, pair);
    return ok ? { ok, leafHash, score: p.leaf.scoreAfter } : { ok, leafHash, score: null, reason: 'path does not fold to root' };
  } catch (e: any) {
    return { ok: false, leafHash: null, score: null, reason: e?.message ?? String(e) };
  }
}

// Standalone: `npx ts-node src/memory/repid-snapshot.ts <proof.json>` — reads {root, leaf, path} and nothing else.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const file = process.argv[2];
  if (!file) { console.error('usage: repid-snapshot.ts <proof.json>'); process.exit(2); }
  const v = verifySnapshotInclusion(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(JSON.stringify(v));
  process.exit(v.ok ? 0 : 1);
}
