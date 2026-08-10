/**
 * LANE DEFINITIONS — the canonical, machine-checked work allocation.
 *
 * WHY THIS FILE EXISTS. `write-lease.ts` can enforce that two lanes do not write the same
 * file, but it cannot tell you what the lanes ARE. Without a committed answer, every
 * session invents its own boundaries, which is how 40+ sessions ended up sharing one
 * working tree with an empty lease registry — a fence installed and never used.
 *
 * THE INVARIANT, AND IT IS TESTED: no two lanes may hold overlapping globs. That is not a
 * convention here; `tests/write-lease.test.ts` runs `patternsMayOverlap` across every pair
 * and fails the build if a new lane collides with an existing one. You cannot add a
 * colliding lane and still ship.
 *
 * WHAT IS DELIBERATELY *NOT* LEASED:
 *   - `reports/**` — append-mostly, a new file per session, near-zero collision risk.
 *     Leasing it would block a HAL run from writing its own eval output for no benefit.
 *   - `src/services/**` — the biggest directory and the REAL contention zone (x402,
 *     agent-*, hal-*, erc8004-*, byok-*, all flat siblings). A blanket lease would hand
 *     one lane a veto over everyone.
 *
 *     The first draft of this file tried to split it by literal prefix — `src/services/hal-*`
 *     to hal, `src/services/x402-*` to identity-pay, and so on. The disjointness test
 *     rejected all 21 pairs, and it was RIGHT: `patternsMayOverlap` reduces every one of
 *     those globs to the literal prefix `src/services/`, because it over-approximates by
 *     design ("over-reports rather than missing"). Same-directory prefix splits therefore
 *     cannot be enforced by this fence, and pretending otherwise would mean loosening the
 *     detector to fit the lanes — backwards, since the detector's conservatism is what
 *     makes a lease trustworthy.
 *
 *     So `src/services/**` stays UNLEASED and coordinated by humans. Only its real
 *     SUBDIRECTORIES (e.g. `src/services/reputation/**`) can be leased, because a
 *     subdirectory has a distinct literal prefix. The durable fix is not a cleverer glob:
 *     it is breaking that 100-file flat directory into subdirectories, at which point each
 *     becomes leasable for free.
 *   Unleased paths are ALLOWED (graduated adoption, property 2 in write-lease.ts). Absence
 *   of a lease is not absence of permission — this system fences the known collisions and
 *   stays out of the way everywhere else.
 *
 * WHAT A LANE IS: one owner, one branch, one worktree, one glob set. The lease covers the
 * FILE collisions. It does NOT cover working-tree-wide operations — branch switches,
 * `npm install`, `dist/` rebuilds — which is why the standing rule is ONE WRITER PER
 * WORKING TREE regardless of leases. Two lanes in one checkout will still break each other
 * even while perfectly respecting each other's files.
 */

/** A lane's stable identity. Set as `HYPERDAG_LANE` by the session that owns it. */
export interface LaneDefinition {
  /** Value of the HYPERDAG_LANE env var. Short, lowercase, stable across sessions. */
  id: string;
  /** One line a human reads in a denial message to know who to talk to. */
  owns: string;
  /** Repo-relative POSIX globs. MUST NOT overlap any other lane's globs. */
  paths: string[];
}

export const LANE_DEFINITIONS: readonly LaneDefinition[] = Object.freeze([
  {
    id: 'hal',
    owns: 'Hallucination Assessment Layer: quorum, fact-check, corpus evals, calibration',
    paths: [
      'src/hal/**',
      'src/decisioning/**',
      'scripts/hal/**',
      'scripts/hal-eval/**',
    ],
  },
  {
    id: 'identity-pay',
    owns: 'Identity, BYOK custody, x402 settlement, staking, HTTP surface',
    paths: [
      'src/routes/**',
      'src/middleware/**',
      'src/billing/**',
      'src/auth/**',
      'src/repid-staking/**',
    ],
  },
  {
    id: 'zkp',
    owns: 'Proofs, Poseidon2/Plonky3, EAS anchoring, proof-carrying memory',
    paths: [
      'src/zkp/**',
      'src/zk-proof/**',
      'src/memory/**',
    ],
  },
  {
    id: 'engine-core',
    owns: 'RepID scoring pipeline: deltas, decay, tiers, badges, score events',
    paths: [
      'src/engine/**',
      'src/layers/**',
      'src/scoring/**',
      'src/repid/**',
      'src/services/reputation/**',
    ],
  },
]);

/** Lookup by id. Returns undefined for an unknown lane rather than throwing — an unknown
 *  lane is an advisory-mode session, not an error (write-lease property 2). */
export function laneById(id: string): LaneDefinition | undefined {
  return LANE_DEFINITIONS.find((l) => l.id === id);
}

/** Every glob owned by any lane, flattened. Used by the disjointness test. */
export function allLanePaths(): Array<{ lane: string; pattern: string }> {
  return LANE_DEFINITIONS.flatMap((l) => l.paths.map((pattern) => ({ lane: l.id, pattern })));
}
