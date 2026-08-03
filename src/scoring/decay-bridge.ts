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
 * REUSES layers/decay.ts unchanged. The math is patent-pending (P-023) and was
 * never the problem; the problem was that nothing called it.
 */

import { computeDecayFactor, applyDecay } from '../layers/decay';

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
  const decayed = applyDecay(from, activity_30d);
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
