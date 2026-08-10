/**
 * NODE REGISTRY — one record per (node, lane), carrying the write LEASE, the CAPABILITY
 * manifest, and the liveness signal together.
 *
 * WHY THESE THREE ARE ONE THING. They were about to be built as three registries. A lease
 * says "what I own", a manifest says "what I can do", a heartbeat says "am I alive" — all
 * three are properties of one running node, keyed the same way, updated on the same tick.
 * Three tables describing one entity is how "is the swarm healthy?" acquires two answers.
 *
 * PURE MODULE, NO I/O. Same discipline as write-lease.ts: this decides, something else
 * persists. That keeps it testable without a database and usable from the hook path.
 *
 * RELATIONSHIP TO write-lease.ts: this does NOT reimplement overlap detection. It maps
 * node records into the existing `LeaseRegistry` shape so `acquireLease` / `evaluateWrite`
 * remain the single source of that logic. A second glob matcher would be a second thing to
 * keep in sync, and the two would disagree exactly when it mattered.
 */

import {
  type LeaseRegistry,
  type WriteLease,
  patternsMayOverlap,
} from './write-lease';
import { LANE_DEFINITIONS } from './lanes';

/** Surfaces a node can run on. Open-ended by design — a new surface is data, not a release. */
export type NodeSurface = string;

export interface NodeRecord {
  /** Stable per MACHINE, not per session. A laptop running 50 sessions is one node. */
  nodeId: string;
  surface: NodeSurface;
  /** Must be an id from LANE_DEFINITIONS. */
  lane: string;

  // --- the lease ---
  owns: string[];
  branch?: string;
  purpose?: string;

  // --- the capability manifest ---
  models: string[];
  cpuCores?: number;
  ramMb?: number;
  region?: string;
  canProve: boolean;
  /**
   * FAIL CLOSED. A 3B model on an old laptop must never silently join the HAL accuracy
   * quorum — weak voters drag F1 and destroy the glass box. Promotion is deliberate.
   */
  canHalVote: boolean;

  // --- liveness / validity (ISO strings, matching write-lease.ts) ---
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

/**
 * Liveness window: 10 minutes.
 *
 * NOT a new number — it is `v_fleet_truth`'s existing threshold
 * (`last_ping > now() - interval '10 minutes'`) reused verbatim. Two definitions of "live"
 * in one system produce two answers to one question, which is the drift this registry
 * exists to prevent.
 *
 * Deliberately SHORTER than the lease TTL (15 min, write-lease.ts): a node reads as NOT
 * LIVE before its paths are released, so a human sees it go dark instead of discovering a
 * silent handoff after the fact.
 */
export const LIVENESS_WINDOW_MS = 10 * 60 * 1000;

/** Is anyone home? Derived from heartbeat recency — never from a stored status. */
export function isLive(rec: NodeRecord, now: number): boolean {
  const t = Date.parse(rec.heartbeatAt);
  // An unparseable heartbeat is NOT live. A node that cannot say when it last spoke is
  // indistinguishable from one that stopped speaking.
  return Number.isFinite(t) && now - t < LIVENESS_WINDOW_MS;
}

/** May this node still write? Separate question from `isLive` — see the TTL note above. */
export function leaseActive(rec: NodeRecord, now: number): boolean {
  const t = Date.parse(rec.expiresAt);
  return Number.isFinite(t) && t > now;
}

/**
 * The nodes whose models may join the HAL ACCURACY quorum.
 *
 * Requires BOTH the explicit promotion and current liveness: a node that was promoted last
 * month but died an hour ago must not be counted as a live voter, or the panel reports a
 * width it does not have — the exact defect behind quoting an F1 measured on a narrower
 * panel than the config claims (CLAUDE_RULES 24).
 */
export function halVoters(recs: readonly NodeRecord[], now: number): NodeRecord[] {
  return recs.filter((r) => r.canHalVote && isLive(r, now));
}

/** Nodes that can only triage — everything live that is not a promoted voter. */
export function triageOnly(recs: readonly NodeRecord[], now: number): NodeRecord[] {
  return recs.filter((r) => !r.canHalVote && isLive(r, now));
}

/**
 * Bridge to write-lease.ts.
 *
 * THE SUBTLETY THAT MATTERS: the lease id is `lane@nodeId`, not `lane`. write-lease treats
 * a lane re-acquiring its own paths as success — that is how renewal works. If two DIFFERENT
 * nodes both claimed lane 'hal' and we keyed on the lane alone, each would look like the
 * other renewing itself and BOTH would be granted the same paths. Keying on the pair makes
 * that a genuine overlap, which the existing conflict check then refuses.
 */
export function toLeaseRegistry(recs: readonly NodeRecord[]): LeaseRegistry {
  const leases: WriteLease[] = recs.map((r) => ({
    lane: `${r.lane}@${r.nodeId}`,
    paths: [...r.owns],
    branch: r.branch ?? '',
    purpose: r.purpose ?? `${r.lane} on ${r.nodeId} (${r.surface})`,
    acquiredAt: r.acquiredAt,
    expiresAt: r.expiresAt,
    heartbeatAt: r.heartbeatAt,
  }));
  return { version: 1, leases };
}

export interface NodeValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Validate a record before it is written. Catches the mistakes that are cheap here and
 * expensive later: an unknown lane (nothing would ever match it), an empty claim (a lease
 * over nothing), and paths that stray outside the lane's own definition.
 */
export function validateNode(rec: NodeRecord): NodeValidation {
  const problems: string[] = [];
  const def = LANE_DEFINITIONS.find((l) => l.id === rec.lane);

  if (!def) {
    problems.push(
      `unknown lane "${rec.lane}" — must be one of ${LANE_DEFINITIONS.map((l) => l.id).join(', ')}`,
    );
  }
  if (rec.owns.length === 0) {
    problems.push('owns is empty — a lease must name at least one path');
  }
  if (def) {
    // A node may claim a SUBSET of its lane, never something outside it. Otherwise the
    // machine-checked disjointness in lanes.ts stops meaning anything at runtime.
    for (const p of rec.owns) {
      if (!def.paths.some((lp) => patternsMayOverlap(lp, p))) {
        problems.push(`path "${p}" is outside lane "${rec.lane}" — claim a subset of the lane`);
      }
    }
  }
  if (!Number.isFinite(Date.parse(rec.expiresAt))) {
    problems.push('expiresAt is unparseable — a lease that cannot say when it ends holds nothing');
  }
  return { ok: problems.length === 0, problems };
}
