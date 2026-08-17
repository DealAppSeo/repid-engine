/**
 * formula-golden-vector.ts — observable formula behaviour cannot change without a version bump.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS CLOSES, WHICH ALREADY HAPPENED
 * ════════════════════════════════════════════════════════════════════════════════
 * On 2026-08-17 the clean branch's orientation was corrected — it consumed hallucination RISK
 * where it needed QUALITY — which changed **every delta the formula produces**. The band, floor
 * and ceiling were untouched, and `CURRENT_FORMULA_PARAMS.version` was not bumped, so
 * `formulaCommitment()` stayed BYTE-IDENTICAL across a behaviour change.
 *
 * The result is the most misleading failure available: an old proof's `formula_commitment` still
 * MATCHES while the recompute check disagrees with its stored delta — so a version skew presents
 * as a FORGED DELTA. Full write-up: docs/FORMULA-VERSIONING.md.
 *
 * The comment on `version` said "bumped by hand". That was the defect, not the instruction: a
 * hand-maintained version behind a hash nobody reads is wired at one end. This module is the
 * other end.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * HOW IT WORKS, AND WHY BOTH FAILURE DIRECTIONS ARE COVERED
 * ════════════════════════════════════════════════════════════════════════════════
 * A fixed vector of inputs is run through the REAL `computeDelta` and the outputs hashed. The
 * digest is pinned in `BEHAVIOUR_DIGESTS`, keyed BY VERSION. A test asserts that today's digest
 * equals the entry for today's version. That covers both mistakes:
 *
 *   • Change behaviour, forget to bump  → today's digest ≠ the pinned entry for this version → RED
 *   • Bump the version, forget the entry → no entry for this version                        → RED
 *
 * Keying by version rather than pinning one constant is what makes the second case fail. A single
 * pinned digest would let someone bump the version and update the digest in the same motion,
 * which is exactly the silent-drift move this is meant to prevent — and it doubles as the seed of
 * the version registry described in docs/FORMULA-VERSIONING.md §3.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE VECTOR COVERS, ON PURPOSE
 * ════════════════════════════════════════════════════════════════════════════════
 * Only REACHABLE combinations. `deriveHalDecision` never emits `clean` at or above 0.40, and a
 * vector containing `clean` at risk 0.95 would pin behaviour production cannot exhibit — which is
 * precisely how the orientation defect survived its own unit tests (LESSONS §6). Every clean row
 * below sits under the flag boundary, and the non-clean decisions are swept across the score range
 * because they legitimately ignore it.
 *
 * It also covers the boundary machinery a band-only commitment cannot see: floor protection, the
 * vesting cliff, and both clamp ends. Those are behaviour, so they belong in the digest.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * PURITY, AND THE ONE ENV FLAG THAT WOULD INVALIDATE THE DIGEST
 * ════════════════════════════════════════════════════════════════════════════════
 * No I/O, no clock, no network. There is exactly one environment input on this path:
 * `REPID_DELTA_FLOOR_RECONCILED` (`src/scoring/repid-delta.ts`), which moves the floor-protection
 * threshold from the legacy 0 to `REPID_MIN`. The three floor rows below (`current_repid` 2, 10, 15)
 * are chosen to STRADDLE that difference, so flipping the flag changes the digest. That is correct
 * and deliberate — the flag changes observable behaviour, so it must not be silently absorbable.
 *
 * Consequence: a digest is pinned FOR THE DEFAULT (flag off). The test asserts the flag is off
 * rather than assuming it, so a CI env change surfaces as an explicit precondition failure instead
 * of an unexplained digest mismatch. When Sean flips that flag, the flag becomes part of the
 * formula regime and needs its own version — see docs/FORMULA-VERSIONING.md.
 */

import { createHash } from 'node:crypto';

import { computeDelta, HALDecision } from '../scoring/repid-delta';

/** One pinned input. Field order is part of the digest — do not reorder. */
export interface GoldenCase {
  readonly hal_score: number;
  readonly hal_decision: HALDecision;
  readonly current_repid: number;
  readonly agent_tier: string;
  readonly vesting_cliff_active: boolean;
}

/**
 * The vector. Append-only in spirit: changing a row changes the digest for every version, which
 * makes historical entries unverifiable. If a new behaviour needs covering, add a row AND bump the
 * version, so the new digest is recorded against the new version.
 */
export const GOLDEN_VECTOR: readonly GoldenCase[] = [
  // ── the clean branch, across the reachable band only (risk < 0.40) ──
  { hal_score: 0.0, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.05, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.1, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.2, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.25, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.3, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.39, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },

  // ── decisions that legitimately ignore the score: swept anyway, so a change shows up ──
  { hal_score: 0.05, hal_decision: 'vetoed', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.9, hal_decision: 'vetoed', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.4, hal_decision: 'flagged', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 1.0, hal_decision: 'flagged', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 0.5, hal_decision: 'abstain', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },

  // ── boundary machinery the band cannot see: floor protection ──
  { hal_score: 0.9, hal_decision: 'vetoed', current_repid: 2, agent_tier: 'PROBATIONARY', vesting_cliff_active: false },
  { hal_score: 0.9, hal_decision: 'vetoed', current_repid: 10, agent_tier: 'PROBATIONARY', vesting_cliff_active: false },
  { hal_score: 0.9, hal_decision: 'vetoed', current_repid: 15, agent_tier: 'PROBATIONARY', vesting_cliff_active: false },

  // ── the vesting cliff: absorbs penalties, must never withhold a reward ──
  { hal_score: 0.9, hal_decision: 'vetoed', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: true },
  { hal_score: 0.05, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: true },

  // ── both clamp ends, via deliberately out-of-spec scores ──
  { hal_score: -1.0, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
  { hal_score: 2.0, hal_decision: 'clean', current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false },
];

/** One observed output. Both deltas are pinned: `applied` alone would hide a clamp/gate change. */
export interface GoldenObservation {
  readonly input: GoldenCase;
  readonly delta_calculated: number;
  readonly delta_applied: number;
}

/** Run the vector through the real formula. */
export function observeGoldenVector(
  vector: readonly GoldenCase[] = GOLDEN_VECTOR,
): GoldenObservation[] {
  return vector.map((input) => {
    const d = computeDelta({ ...input });
    return { input, delta_calculated: d.delta_calculated, delta_applied: d.delta_applied };
  });
}

/**
 * Digest of the vector's observed behaviour.
 *
 * SHA-256 over a canonical line-per-case rendering. Deliberately not Poseidon2: this digest is
 * never proved in a circuit, it is a build-time tripwire, and a plain hash keeps it readable in a
 * failure message. Deltas are rendered `toFixed(4)` so a float-representation wobble cannot flip
 * the digest without a real behaviour change.
 */
export function behaviourDigest(vector: readonly GoldenCase[] = GOLDEN_VECTOR): string {
  const lines = observeGoldenVector(vector).map((o) =>
    [
      o.input.hal_score.toFixed(4),
      o.input.hal_decision,
      String(o.input.current_repid),
      o.input.agent_tier,
      o.input.vesting_cliff_active ? 'vesting' : 'vested',
      o.delta_calculated.toFixed(4),
      o.delta_applied.toFixed(4),
    ].join('|'),
  );
  return `sha256:${createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')}`;
}

/**
 * Pinned behaviour digest per formula version.
 *
 * ADD AN ENTRY WHEN YOU BUMP THE VERSION. Do not edit an existing entry: an entry describes what
 * that version's formula DID, and rewriting it makes every proof issued under that version
 * unverifiable against its own declared regime.
 *
 * `repid-delta-a7` has no entry on purpose — it is the pre-bump orientation, and its behaviour is
 * no longer in the tree to observe. That absence is itself the record: a proof declaring a7 cannot
 * have its delta recomputed here, which is exactly the NOT_CHECKED case in
 * docs/FORMULA-VERSIONING.md §3, rather than a false FAILED.
 */
export const BEHAVIOUR_DIGESTS: Readonly<Record<string, string>> = {
  'repid-delta-a8-quality-oriented':
    'sha256:93f86625bcb67b3820aefdc5785ff15182d97b3f2cc0d28ec68e6ef2a816306e',
};

/** Versions whose delta function is no longer in the tree, so a recompute is NOT_CHECKED not FAILED. */
export const UNRECOMPUTABLE_VERSIONS: readonly string[] = ['repid-delta-a7'];
