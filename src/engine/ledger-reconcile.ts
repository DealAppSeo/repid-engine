/**
 * ledger-reconcile.ts — make an engine audit row unable to deny a movement it caused.
 *
 * THE SHAPE THIS EXISTS TO STOP. A score-event row that reads "no penalty applied"
 * (`delta: 0`, or suppression metadata saying the penalty was withheld) while the
 * agent's score moved. 25,418 such rows are in prod from 2026-05-29..06-03 — every
 * one a HAL_SCORE_EVENT written by `scoring/pipeline.ts`, whose app-side suppression
 * has since closed that window. Those rows are NOT this module's subject; they are
 * cited because they are the proof that the shape is reachable and expensive: their
 * `repid_delta_applied` still sums to a six-figure drain that never happened, so any
 * consumer that sums that column reads a number the roster never lost.
 *
 * WHY `engine/repid-update.ts` CAN EMIT THE SAME LIE. `updateRepId` writes
 *
 *     delta        = the event delta
 *     repid_before = the UN-decayed score
 *     repid_after  = clamp(decayed + delta)
 *
 * and leaves `repid_delta_applied` unset. Two movers therefore never appear in
 * `delta`:
 *
 *   DECAY.  `layers/decay.ts::applyDecay` runs unconditionally on this path — there
 *     is no mode flag in front of it. It is a real, non-zero subtraction for an agent
 *     with low 30-day activity. So an event whose penalty was correctly withheld
 *     (delta 0 — an unproven STAKE, an enforce-zeroed self-report, an unconfirmed
 *     deception advisory) still lands a row whose score went DOWN. The row says
 *     nothing was applied. The score disagrees.
 *   THE CLAMP.  [10, 10000]. An agent at a bound absorbs the delta and moves less
 *     than the row claims.
 *
 * AND `repid_delta_applied` BEING NULL IS NOT NEUTRAL. The live BEFORE INSERT trigger
 * `apply_repid_score_event` backs off only when that column is already set. Left NULL
 * with a non-zero delta, the trigger applies `before + delta` — decay-free — stamps
 * `repid_delta_applied` with that decay-free number, mirrors it into
 * `agent_repid_history`, and is then silently overwritten by this module's caller
 * writing the decayed absolute score. The stamped "applied" value is the one number
 * on the row guaranteed not to be the movement.
 *
 * THE CORRECTION CHOSEN: RECORD IT HONESTLY, not "suppress the penalty properly".
 *   - Decay is not a penalty being wrongly applied; it is a designed layer (P-023)
 *     that the live path has been missing, and a sibling workstream is deliberately
 *     bringing it back under its own flag. Deleting it here would fight that and
 *     would be a scoring change dressed as a bug fix.
 *   - The repo already states the invariant a row owes — `repid_after - repid_before
 *     === repid_delta_applied` (scoring/score-event-writer.ts::reconciles) — and
 *     already treats `delta` (earned) diverging from `repid_delta_applied` (moved) as
 *     the audit signal rather than a defect. Satisfying that invariant is compatible
 *     with any future decision about whether decay should run at all.
 *   - Honest recording is strictly recoverable. Silent suppression is not: once a
 *     movement is unrecorded, no later reader can reconstruct it.
 *
 * FLAG: ENGINE_LEDGER_RECONCILE_MODE = off | shadow | enforce. DEFAULT off.
 *   off     — the row is byte-identical to today. No column, no metadata key.
 *   shadow  — metadata only. Records the decomposition and whether the row
 *             reconciles. No column written, no trigger behaviour changed, no score
 *             touched. This is the measurement.
 *   enforce — additionally sets `repid_delta_applied` to the ACTUAL movement, so the
 *             row satisfies the invariant and the DB trigger backs off, leaving one
 *             applier. LIVE change: it changes which actor applies the delta.
 *
 * DETECTION IS NOT BEHIND THE FLAG. `contradiction` is computed in every mode and
 * logged loudly, because a knob that has to be switched on before a lie is noticed is
 * the failure mode this module exists to end. Logging moves no score.
 */

/** off = inert · shadow = metadata only · enforce = writes repid_delta_applied. */
export type LedgerMode = 'off' | 'shadow' | 'enforce';

/** Anything but the explicit words resolves to `off` — escalation is never incidental. */
export function parseLedgerMode(raw: string | undefined | null): LedgerMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

export function ledgerMode(): LedgerMode {
  return parseLedgerMode(process.env.ENGINE_LEDGER_RECONCILE_MODE);
}

export interface LedgerAssessment {
  mode: LedgerMode;
  /** Score before anything was applied. Integer. */
  before: number;
  /** Score the caller actually persisted. Integer. */
  after: number;
  /** Points decay removed. <= 0. */
  decay_points: number;
  /** The event delta the row declares in its `delta` column. */
  delta_points: number;
  /** Points the [10, 10000] clamp added or removed. */
  clamp_points: number;
  /** The real movement: after - before, and identically decay + delta + clamp. */
  total_applied: number;
  /**
   * True when the APPLICATION wrote `repid_agents`. False on an inert shadow path or
   * with WRITER_DIRECT_APPLY off, where the DB trigger is the applier instead.
   * Enforce must not claim an application the caller did not perform — see
   * `ledgerColumns`.
   */
  score_mutated: boolean;
  /** total_applied === delta_points. The invariant the row owes. */
  reconciles: boolean;
  /**
   * THE NAMED SHAPE: the row declares no delta while the score moved. A strict
   * subset of `!reconciles`, kept separate because it is the one a human reads as
   * "nothing happened" and is therefore the one that misleads silently.
   */
  contradiction: boolean;
}

/**
 * Decompose a movement into the three things that can cause it.
 *
 * The identity `decay + delta + clamp === after - before` holds exactly because all
 * four inputs are integers: the caller rounds the decayed base before the delta lands
 * (see layers/decay.ts::applyDecay), so no half-point residue has to be attributed to
 * one component arbitrarily.
 */
export function assessLedger(params: {
  before: number;
  /** The decayed base the delta was added to. Equals `before` when decay took nothing. */
  decayedTo: number;
  /** The event delta, i.e. what the row's `delta` column will say. */
  delta: number;
  /** The score the caller persisted (post-clamp). */
  after: number;
  /** Whether the caller actually wrote `repid_agents`. */
  scoreMutated: boolean;
  mode?: LedgerMode;
}): LedgerAssessment {
  const mode = params.mode ?? ledgerMode();
  const { before, decayedTo, delta, after, scoreMutated } = params;

  // THE APP DID NOT APPLY. Either the path is inert (nothing moves at all) or
  // WRITER_DIRECT_APPLY is off and the DB trigger is the applier — and the trigger
  // applies exactly `COALESCE(repid_delta_calculated, delta, 0)` with no decay and no
  // clamp. Either way the movement IS the delta, so the row reconciles by
  // construction and cannot carry the contradiction. Reporting this path's
  // counterfactual decay as an applied component would invent a movement — the error
  // this module exists to prevent, inverted.
  if (!scoreMutated) {
    return {
      mode,
      before,
      after: before + delta,
      decay_points: 0,
      delta_points: delta,
      clamp_points: 0,
      total_applied: delta,
      score_mutated: false,
      reconciles: true,
      contradiction: false,
    };
  }

  const decay_points = decayedTo - before;
  const clamp_points = after - (decayedTo + delta);
  const total_applied = after - before;

  return {
    mode,
    before,
    after,
    decay_points,
    delta_points: delta,
    clamp_points,
    total_applied,
    score_mutated: true,
    reconciles: total_applied === delta,
    contradiction: delta === 0 && total_applied !== 0,
  };
}

/**
 * Metadata to merge into the audit row. Empty in `off` — a mode that adds a key to
 * every event is not off.
 */
export function ledgerMetadata(a: LedgerAssessment): Record<string, unknown> {
  if (a.mode === 'off') return {};
  return {
    ledger_reconcile: {
      mode: a.mode,
      before: a.before,
      after: a.after,
      decay_points: a.decay_points,
      delta_points: a.delta_points,
      clamp_points: a.clamp_points,
      total_applied: a.total_applied,
      score_mutated: a.score_mutated,
      reconciles: a.reconciles,
      contradiction: a.contradiction,
      // In shadow this names the column enforce WOULD have written, so the flip can
      // be sized from the recorded rows rather than guessed.
      would_write_repid_delta_applied: a.score_mutated ? a.total_applied : null,
    },
  };
}

/**
 * The column to merge into the insert payload. Empty unless `enforce`.
 *
 * GUARDED ON `score_mutated` FOR A REASON THAT IS NOT COSMETIC. Setting
 * `repid_delta_applied` makes the DB trigger `apply_repid_score_event` back off. If
 * the caller also did not write `repid_agents` (WRITER_DIRECT_APPLY off, or an inert
 * shadow path), enforcing here would leave NO applier at all and the delta would
 * silently vanish. So enforce writes the column only when the caller has taken
 * ownership of the score.
 */
export function ledgerColumns(a: LedgerAssessment): Record<string, unknown> {
  if (a.mode !== 'enforce' || !a.score_mutated) return {};
  return { repid_delta_applied: a.total_applied };
}

let _modeLogged = false;

/**
 * Announce the resolved mode once, and shout on every contradicting row REGARDLESS
 * of mode. A ledger that disagrees with itself is not a metric to sample; it is a
 * defect to see immediately.
 */
export function logLedger(a: LedgerAssessment, context: { agentId: string; eventType: string }): void {
  if (!_modeLogged) {
    _modeLogged = true;
    console.log(
      `[repid-engine] ENGINE_LEDGER_RECONCILE_MODE='${a.mode}' (default 'off'; off|shadow|enforce). ` +
        (a.mode === 'enforce'
          ? 'ENFORCE: repid_delta_applied is set to the real movement; the DB apply trigger backs off.'
          : a.mode === 'shadow'
            ? 'SHADOW: metadata only — no column, no score change.'
            : 'OFF: rows unchanged; contradictions are still detected and logged.')
    );
  }
  if (a.contradiction) {
    console.error(
      `[repid-engine] LEDGER CONTRADICTION agent=${context.agentId} event=${context.eventType} ` +
        `declared delta=0 but the score moved ${a.total_applied} ` +
        `(decay=${a.decay_points} clamp=${a.clamp_points}). ` +
        `The row denies a movement it caused.`
    );
  } else if (!a.reconciles && a.score_mutated) {
    console.warn(
      `[repid-engine] LEDGER DOES NOT RECONCILE agent=${context.agentId} event=${context.eventType} ` +
        `delta=${a.delta_points} movement=${a.total_applied} ` +
        `(decay=${a.decay_points} clamp=${a.clamp_points}).`
    );
  }
}

/** Reset the once-per-process log latch. Tests only. */
export function __resetLedgerLogLatch(): void {
  _modeLogged = false;
}
