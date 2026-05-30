/**
 * RepID dormancy decay — pure formula (sprint 2026-05-29, Part A).
 *
 * WHY: repid_agents.decay_rate is populated (0.0015) but read by NOTHING — the
 * DORMANCY-SPIKE is undefended: a high-RepID agent can go dormant indefinitely
 * then wake to sign a critical action. This module supplies the missing read.
 *
 * SEAN DECISIONS (locked, honored here):
 *  - FLOOR: RepID never decays below the agent's CURRENT tier's lower bound
 *    (Micah 6:8 — punish dormancy, never erase earned standing).
 *  - DECAYING-DECAY: the rate itself eases as an agent proves sustained activity
 *    (rewards longevity).
 *  - Active agents (idle < 1 week) → near-zero decay; only dormancy bites.
 *  - Scope (enforced by the caller/script): lifecycle_status='active' ONLY.
 *
 * decay_rate SEMANTICS (documented — the column had no prior reader to fix it):
 *   decay_rate = fractional RepID decay per IDLE WEEK. 0.0015 = 0.15%/week.
 *   Cadence is weekly (operator-run). This is the chosen interpretation; see the
 *   report. Tweak DECAY constants below, not call sites.
 *
 * This is a PURE function (now + agent in, result out) — unit-tested against
 * hand-computed cases. No DB, no I/O.
 */

/** compute_tier() boundaries, verified against live schema [sql:2026-05-29]. */
export const TIER_LOWER_BOUNDS = {
  PROBATIONARY: 0,
  EARNING: 500,
  ESTABLISHED: 1000,
  AUTONOMOUS: 5000,
  VETERAN: 8000,
} as const;

/** Tier name for a repid (mirrors compute_tier(); for preview/reporting only). */
export function tierName(repid: number): keyof typeof TIER_LOWER_BOUNDS {
  if (repid >= 8000) return 'VETERAN';
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'ESTABLISHED';
  if (repid >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

/** Lower bound of the tier that `repid` currently sits in (the decay floor). */
export function tierLowerBound(repid: number): number {
  if (repid >= 8000) return 8000;
  if (repid >= 5000) return 5000;
  if (repid >= 1000) return 1000;
  if (repid >= 500) return 500;
  return 0;
}

// Decaying-decay tuning (documented + tweakable). The effective rate eases with
// sustained activity: effective = base * modifier, modifier in [MIN_MODIFIER, 1].
const SUSTAIN_EASE_PER_WEEK = 0.02; // each sustained-active week shaves 2% off the rate
const MIN_DECAY_MODIFIER = 0.25;    // rate never eases below 25% of base (dormancy still bites)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DecayAgentInput {
  agent_id?: string;
  agent_name?: string;
  current_repid: number;
  decay_rate: number | null;
  last_active_at: string | null;
  /** Account creation — proxies sustained-activity tenure for decaying-decay. */
  created_at?: string | null;
  lifecycle_status?: string | null;
  /** Optional explicit sustained-activity measure (weeks). Overrides the tenure proxy. */
  sustained_activity_weeks?: number | null;
}

export interface DecayResult {
  agent_id?: string;
  agent_name?: string;
  repid_before: number;
  repid_after: number;
  decay_amount: number;
  floor: number;
  weeks_idle: number;
  base_rate: number;
  sustained_modifier: number;
  effective_rate: number;
  floored: boolean;
  /** When set, the agent was NOT decayed and must be surfaced for review. */
  skip?: 'indeterminate_activity' | 'non_active_status' | 'no_decay_rate';
}

/**
 * Decaying-decay modifier: longer sustained activity → smaller modifier (rate
 * eases). Clamped to [MIN_DECAY_MODIFIER, 1]. Simple + documented.
 */
export function sustainedActivityModifier(sustainedWeeks: number): number {
  const m = 1 - SUSTAIN_EASE_PER_WEEK * Math.max(0, sustainedWeeks);
  return Math.min(1, Math.max(MIN_DECAY_MODIFIER, m));
}

/**
 * Compute dormancy decay for one agent. Pure: `nowMs` is injectable for tests.
 *
 * Skip-and-flag (never silent-decay):
 *  - non-'active' lifecycle_status → skip 'non_active_status' (guard; the script
 *    selects active-only, this is defense-in-depth).
 *  - last_active_at NULL → skip 'indeterminate_activity' (cannot measure idleness;
 *    decaying on an unknown is unjust — surface for review).
 *  - decay_rate NULL → skip 'no_decay_rate'.
 */
export function decayRepid(agent: DecayAgentInput, nowMs: number): DecayResult {
  const base: Omit<DecayResult, 'skip'> = {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    repid_before: agent.current_repid,
    repid_after: agent.current_repid,
    decay_amount: 0,
    floor: tierLowerBound(agent.current_repid),
    weeks_idle: 0,
    base_rate: agent.decay_rate ?? 0,
    sustained_modifier: 1,
    effective_rate: 0,
    floored: false,
  };

  if (agent.lifecycle_status != null && agent.lifecycle_status !== 'active') {
    return { ...base, skip: 'non_active_status' };
  }
  if (agent.last_active_at == null) {
    return { ...base, skip: 'indeterminate_activity' };
  }
  if (agent.decay_rate == null) {
    return { ...base, skip: 'no_decay_rate' };
  }

  const lastActiveMs = new Date(agent.last_active_at).getTime();
  const weeksIdle = Math.max(0, (nowMs - lastActiveMs) / WEEK_MS);

  // Sustained-activity weeks: explicit measure if provided, else tenure proxy.
  const sustainedWeeks =
    agent.sustained_activity_weeks != null
      ? agent.sustained_activity_weeks
      : agent.created_at
        ? Math.max(0, (nowMs - new Date(agent.created_at).getTime()) / WEEK_MS)
        : 0;
  const modifier = sustainedActivityModifier(sustainedWeeks);
  const effectiveRate = agent.decay_rate * modifier;

  const floor = tierLowerBound(agent.current_repid);
  const decayedRaw = agent.current_repid * Math.pow(1 - effectiveRate, weeksIdle);
  const flooredVal = Math.max(decayedRaw, floor);
  const repidAfter = Math.round(flooredVal);

  return {
    ...base,
    repid_after: repidAfter,
    decay_amount: agent.current_repid - repidAfter,
    floor,
    weeks_idle: weeksIdle,
    sustained_modifier: modifier,
    effective_rate: effectiveRate,
    floored: flooredVal === floor && decayedRaw < floor,
  };
}
