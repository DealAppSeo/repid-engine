/**
 * decay-sweep.ts — measure decay exposure across the WHOLE roster, not just the
 * agents that happen to be generating events.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AND THE EVENT HOOK DOES NOT REPLACE IT
 * ════════════════════════════════════════════════════════════════════════════════
 * `scoring/pipeline.ts` already assesses decay on every score event and records the
 * counterfactual via `decayMetadata`. That path is healthy — 100% of events since
 * 2026-08-10 carry it — and it is not what this replaces.
 *
 * It cannot answer the ratchet's question. Decay is a function of INACTIVITY, and
 * an event-triggered hook only ever observes agents that emit events. Measured
 * 2026-08-17: 71 observations covering 13 of 176 agents across 14 days, while 131
 * agents have zero 30-day activity. The population whose decay exposure decides the
 * ratchet is exactly the population that emits nothing. More waiting yields more
 * data about the active 13 and none about the inactive 131.
 *
 * A sweep inverts the trigger: iterate the roster, assess every agent, record the
 * counterfactual. That is the only way the inactive cohort is ever observed.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THIS NEVER MOVES A SCORE — AND IS BUILT SO IT CANNOT
 * ════════════════════════════════════════════════════════════════════════════════
 * A job that walks every agent applying decay is a mass-mutation vector: one wrong
 * flag and 176 agents move at once, visible on every badge and, via ERC-8004,
 * on-chain. So the mode is not read from the environment here. It is HARD-CODED to
 * 'shadow' and asserted before any write, and the table carries
 * `check (mode = 'shadow')` so the database refuses an enforcing row even if this
 * code is wrong. `REPID_DECAY_MODE=enforce` does not change what a sweep does.
 *
 * The sweep writes only to `repid_decay_shadow_observations`. It never touches
 * `repid_agents` or `repid_score_events`.
 */
import { createHmac } from 'node:crypto';
import { db } from '../db';
import { assessDecay, type DecayAssessment } from './decay-bridge';
import { scoringParams } from '../config/scoring-params';

/** One agent's row, as the sweep needs it. */
interface RosterRow {
  id: string;
  current_repid: number | null;
  activity_30d: number | null;
}

export interface DecaySweepObservation {
  agent_id: string;
  mode: 'shadow';
  repid_before: number;
  decayed_to: number;
  would_remove: number;
  factor: number;
  activity_30d: number;
}

export interface DecaySweepResult {
  sweep_id: string;
  observed: number;
  /** Agents whose score decay would reduce, had it been enforced. */
  would_bite: number;
  /** Of `observed`, how many had zero 30-day activity — the ratchet's cohort. */
  zero_activity: number;
  total_points_at_risk: number;
  max_would_remove: number;
  params_ruler: string | null;
  written: number;
}

/**
 * A comparability token for the tuned constants, NOT a disclosure of them.
 *
 * Lesson 8: a measurement without its ruler is not a result. Two sweeps taken
 * either side of a re-tune are not comparable, and nothing else on the row would
 * reveal that. The constants are secret (P-023, and this repo is public), so the
 * row carries an HMAC over them rather than the values.
 *
 * Keyed, not a bare hash: four floats through a plain digest are grid-searchable
 * given the model shape, which is in this file's sibling. Without a salt we record
 * NULL and say so — a missing ruler is reported, never faked.
 */
export function paramsRuler(
  salt: string | undefined = process.env.SCORING_RULER_SALT,
): string | null {
  if (!salt) return null;
  const p = scoringParams();
  const material = [p.decayLambda, p.decayK, p.decayFloor, p.decayCap].join('|');
  return createHmac('sha256', salt).update(material).digest('hex').slice(0, 16);
}

/**
 * Assess one agent. Pure: no I/O, so the arithmetic is testable without a database
 * and without the tuned constants being present.
 */
export function observeAgent(row: RosterRow): DecaySweepObservation | null {
  // An unscored agent is not an observation. Checked BEFORE coercion on purpose:
  // `Number(null)` is 0, not NaN, so a finite-check alone admits a null score as a
  // real agent sitting at zero — which the floor then lifts to REPID_MIN. That
  // fabricates floor-sitters in the exact distribution this sweep exists to count.
  if (row.current_repid === null || row.current_repid === undefined) return null;
  const before = Number(row.current_repid);
  if (!Number.isFinite(before)) return null;
  const activity = Number.isFinite(Number(row.activity_30d))
    ? Number(row.activity_30d)
    : 0;

  // Mode is pinned, never read from env. See the header.
  const a: DecayAssessment = assessDecay({
    currentRepid: before,
    activity30d: activity,
    mode: 'shadow',
  });

  return {
    agent_id: row.id,
    mode: 'shadow',
    repid_before: a.from,
    decayed_to: a.decayed_to,
    would_remove: a.would_remove,
    factor: Number(a.factor.toFixed(6)),
    activity_30d: a.activity_30d,
  };
}

/** Summarise a set of observations. Pure, so the reporting is testable too. */
export function summarise(
  observations: DecaySweepObservation[],
): Omit<DecaySweepResult, 'sweep_id' | 'params_ruler' | 'written'> {
  return {
    observed: observations.length,
    would_bite: observations.filter((o) => o.would_remove > 0).length,
    zero_activity: observations.filter((o) => o.activity_30d === 0).length,
    total_points_at_risk: observations.reduce((s, o) => s + o.would_remove, 0),
    max_would_remove: observations.reduce((m, o) => Math.max(m, o.would_remove), 0),
  };
}

/**
 * Run one sweep over the whole roster.
 *
 * Throws when the roster reads empty. A sweep that observes nobody and returns
 * cleanly is indistinguishable from a healthy sweep of a healthy roster, and would
 * sit in cron reporting success forever — the failure this codebase keeps
 * relearning. Empty is a fault, not a result.
 */
export async function runDecaySweep(opts?: {
  sweepId?: string;
  /** Set false to compute and summarise without writing. */
  persist?: boolean;
}): Promise<DecaySweepResult> {
  const sweep_id = opts?.sweepId ?? crypto.randomUUID();
  const persist = opts?.persist ?? true;

  const { data, error } = await db
    .from('repid_agents')
    .select('id, current_repid, activity_30d');

  if (error) throw new Error(`decay sweep: roster read failed: ${error.message}`);

  const roster = (data ?? []) as RosterRow[];
  if (roster.length === 0) {
    throw new Error(
      'decay sweep: roster is empty — refusing to report a sweep of nobody as a successful sweep',
    );
  }

  const observations = roster
    .map(observeAgent)
    .filter((o): o is DecaySweepObservation => o !== null);

  const ruler = paramsRuler();
  if (!ruler) {
    console.warn(
      '[decay-sweep] SCORING_RULER_SALT unset — observations carry no ruler and ' +
        'cannot be compared across a parameter re-tune. The sweep itself is still valid.',
    );
  }

  let written = 0;
  if (persist && observations.length > 0) {
    const rows = observations.map((o) => ({
      sweep_id,
      agent_id: o.agent_id,
      mode: o.mode,
      repid_before: o.repid_before,
      decayed_to: o.decayed_to,
      would_remove: o.would_remove,
      factor: o.factor,
      activity_30d: o.activity_30d,
      params_ruler: ruler,
    }));
    const { error: insErr, count } = await db
      .from('repid_decay_shadow_observations')
      .insert(rows, { count: 'exact' });
    if (insErr) throw new Error(`decay sweep: write failed: ${insErr.message}`);
    written = count ?? rows.length;
  }

  return { sweep_id, params_ruler: ruler, written, ...summarise(observations) };
}
