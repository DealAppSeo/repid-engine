/**
 * decay-bridge.ts — Option C step 1: bring decay to the path that actually runs.
 *
 * Decision: reports/2026-08-02/REPID_TWO_PATH_DIVERGENCE.md, Option C (Sean,
 * 2026-08-03). Port the dormant layers into the live pipeline one at a time, each
 * behind its own flag, each measured in shadow before enforce.
 *
 * THE PROBLEM THIS IS STEP ONE OF. `engine/repid-update.ts::updateRepId` — the
 * pipeline CLAUDE.md documents as canonical, with decay, redemption,
 * ecosystem-need and badges — has written ZERO of the last 35,501 score events.
 * `scoring/pipeline.ts` writes them all and applies none of those layers. So RepID
 * only ratchets up: an idle agent keeps its score forever, and every surface built
 * on it (manifest, TrustBadge, leaderboard) reports decay-free numbers as a track
 * record.
 *
 * WHY SHADOW IS NOT OPTIONAL HERE. Decay is computed from 30-day activity. Turning
 * it on applies 30+ days of absent decay in one step, per agent, across the whole
 * roster — visible on every badge and, via ERC-8004, on-chain. "Our scores all
 * dropped because we enabled a feature" is a hard sentence to publish on a trust
 * product. So shadow mode computes the number, records it, changes nothing, and
 * lets the distribution be read before anyone decides how to land it.
 *
 * FLAG: REPID_DECAY_MODE = off | shadow | enforce. Default OFF — not even shadow,
 * because shadow still writes a new metadata key on every event and that should be
 * a deliberate act.
 *
 * REUSES layers/decay.ts unchanged. The math was never the problem; the problem
 * was that nothing called it.
 */

import { computeDecayFactor, applyDecay } from '../layers/decay';
import { clampRepid } from './repid-clamp';

export type DecayMode = 'off' | 'shadow' | 'enforce';

export function parseDecayMode(raw: string | undefined | null): DecayMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

export function decayMode(): DecayMode {
  return parseDecayMode(process.env.REPID_DECAY_MODE);
}

export interface DecayAssessment {
  mode: DecayMode;
  /** The score decay would produce. Equals `from` when mode is 'off'. */
  decayed_to: number;
  from: number;
  /** Positive points decay would remove. 0 when none applies. */
  would_remove: number;
  factor: number;
  activity_30d: number;
  /** True only when the score was actually changed. */
  applied: boolean;
}

/**
 * What decay would do, and whether it did it.
 *
 * Always returns a full assessment so the caller can record the counterfactual in
 * shadow mode. `decayed_to` is only meaningfully different from `from` when the
 * mode is 'enforce' — in shadow the caller must use `from`.
 */
export function assessDecay(params: {
  currentRepid: number;
  activity30d: number;
  mode?: DecayMode;
}): DecayAssessment {
  const mode = params.mode ?? decayMode();
  const from = params.currentRepid;
  const activity_30d = Number.isFinite(params.activity30d) ? params.activity30d : 0;

  if (mode === 'off') {
    return {
      mode,
      decayed_to: from,
      from,
      would_remove: 0,
      factor: 1,
      activity_30d,
      applied: false,
    };
  }

  const factor = computeDecayFactor({ currentRepId: from, activity30d: activity_30d });
  // INTEGRAL BY CONTRACT. `repid_before`/`repid_after`/`repid_delta_applied` are all
  // `integer` columns [verified against information_schema 2026-08-03], so the decayed
  // base has to be a whole number or the stored delta cannot equal the stored movement.
  // `layers/decay.ts::applyDecay` already rounds, so this is a no-op today (asserted in
  // tests/scoring-floor-and-decay-reconcile.test.ts) — it is here so the ledger identity
  // does not silently depend on the internals of a module outside this directory.
  const decayed = Math.round(applyDecay(from, activity_30d));
  const would_remove = Math.max(0, from - decayed);

  return {
    mode,
    decayed_to: decayed,
    from,
    would_remove,
    factor,
    activity_30d,
    applied: mode === 'enforce' && would_remove > 0,
  };
}

/**
 * The score to actually use. In shadow this is the UNDECAYED score — shadow must
 * never move a number, or it is not shadow.
 */
export function decayedScoreFor(a: DecayAssessment): number {
  return a.applied ? a.decayed_to : a.from;
}

/**
 * THE DECAY / ROUNDING COUPLING, AND WHY THE LEDGER STOPPED ADDING UP.
 *
 * `score-event-writer.ts::reconciles` states the invariant every audit row owes:
 *
 *     repid_after - repid_before === repid_delta_applied
 *
 * and its comment names the exact way to satisfy it — "if something other than the
 * delta moved the score (e.g. decay), it must be included in repid_delta_applied or
 * recorded as its own event." `applyValidationEvent` includes it. `runScoreEvent`
 * stored the HAL delta instead, so two things could move the score without appearing
 * in the delta:
 *
 *   DECAY. Under REPID_DECAY_MODE=enforce the base is the DECAYED score while
 *     repid_before is the un-decayed one, so the row is off by `would_remove`.
 *   THE CLAMP. #314's clampRepid pins the score at 10 / 10000. An agent AT the
 *     ceiling taking +2 moves 0 points and recorded +2. Verified 2026-08-03: one
 *     live agent sits at exactly 10000, so this half is reachable with decay OFF.
 *     (Both halves are latent, not historical — the 25,418 non-reconciling rows in
 *     prod are all HAL_SCORE_EVENTs from 2026-05-29..06-03, a different defect.)
 *
 * ROUNDING ORDER: round the DECAYED BASE first, then add the delta.
 * `Math.round(before + d) === before + Math.round(d)` holds only while `before` is an
 * integer. If the base were left fractional, `repid_after` would be a single rounded
 * number that cannot be decomposed — the half-point residue would land entirely on
 * whichever component you chose to attribute it to, and `decay_points + delta_points`
 * would miss `after - before` by up to 1 with no record of which one absorbed it.
 * Rounding the base makes `decay_points` an exact integer, so each component is
 * independently auditable and the three of them sum to the movement EXACTLY.
 */
export interface AppliedScore {
  /** The agent's score before anything was applied. Integer. */
  before: number;
  /** Points decay removed. <= 0, and 0 unless mode is 'enforce'. Integer. */
  decay_points: number;
  /** Points the event's delta moved, rounded ONCE. Integer. */
  delta_points: number;
  /** Points given up to the [REPID_MIN, REPID_MAX] clamp. Integer. */
  clamp_points: number;
  /** The score actually written. Integer, always in range. */
  after: number;
  /**
   * What `repid_delta_applied` must be for the row to reconcile.
   * Always exactly `decay_points + delta_points + clamp_points`.
   */
  total_applied: number;
}

/**
 * Decompose "the score moved" into the components that moved it.
 *
 * `clamp` is injectable only so the pipeline can keep `clampRepidLoud`'s operator
 * warning without clamping twice; the default is the plain clamp.
 */
export function applyToScore(params: {
  before: number;
  decay: DecayAssessment;
  rawDelta: number;
  clamp?: (raw: number) => number;
}): AppliedScore {
  const clamp = params.clamp ?? ((raw: number) => clampRepid(raw).value);
  const before = Math.round(params.before);
  const decayBase = decayedScoreFor(params.decay);
  const decay_points = decayBase - before;
  const delta_points = Math.round(Number.isFinite(params.rawDelta) ? params.rawDelta : 0);
  const after = clamp(decayBase + delta_points);
  const clamp_points = after - (decayBase + delta_points);
  return {
    before,
    decay_points,
    delta_points,
    clamp_points,
    after,
    total_applied: after - before,
  };
}

/** The invariant `score-event-writer.ts::reconciles` will check on the row. */
export function appliedScoreReconciles(a: AppliedScore): boolean {
  return (
    a.after - a.before === a.total_applied &&
    a.decay_points + a.delta_points + a.clamp_points === a.total_applied
  );
}

/** Compact record for metadata, so the decomposition survives into the audit row. */
export function appliedScoreMetadata(a: AppliedScore): Record<string, unknown> {
  return {
    applied: {
      before: a.before,
      after: a.after,
      decay_points: a.decay_points,
      delta_points: a.delta_points,
      clamp_points: a.clamp_points,
      total_applied: a.total_applied,
      reconciles: appliedScoreReconciles(a),
    },
  };
}

/** Compact record for metadata, so a shadow run is measurable after the fact. */
export function decayMetadata(a: DecayAssessment): Record<string, unknown> {
  return {
    decay: {
      mode: a.mode,
      applied: a.applied,
      from: a.from,
      decayed_to: a.decayed_to,
      would_remove: a.would_remove,
      factor: Number(a.factor.toFixed(6)),
      activity_30d: a.activity_30d,
    },
  };
}
