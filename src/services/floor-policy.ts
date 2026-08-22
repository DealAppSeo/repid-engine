/**
 * floor-policy.ts — what each candidate shape of the reputation floor would
 * actually do.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DECISION THIS SERVES
 * ════════════════════════════════════════════════════════════════════════════
 * `trg_repid_earned_floor` clamps an agent's score up to
 * `tier_lower_bound(peak_repid)`, where the peak is an all-time high-water mark.
 * Measured 2026-08-21 with 25 consecutive confident faults against an agent
 * peaked at 10000: faults 1–17 cost the full penalty, fault 18 is partially
 * absorbed, and **faults 19 onward cost exactly zero, permanently.**
 *
 * That is a real tension, not a bug to delete. The floor exists for a good
 * reason — one catastrophic event should not erase a career, which is the same
 * just-culture instinct behind the confession discount. But an all-time peak
 * means the protection never expires, so past a point defection is free.
 *
 * **Every option trades the same two quantities against each other**, and the
 * whole purpose of this module is to make that trade visible instead of
 * arguable:
 *
 *   - **Penalty absorbed** — points an agent did not pay because the floor
 *     caught them. This is the cost of the policy. At zero, defection is never
 *     free; the ratchet is also doing nothing.
 *   - **Worst single drop prevented** — the largest one-event fall the floor
 *     cushioned. This is the benefit, and it is the reason not to simply remove
 *     the floor.
 *
 * A policy that absorbs nothing has no benefit either. A policy that absorbs
 * everything has no cost to defecting. The answer is somewhere between, and it
 * depends on values rather than arithmetic — which is why this computes both
 * numbers for each candidate and decides nothing.
 *
 * Pure: no clock, no I/O. A trajectory is a function of the event list and the
 * policy, so two people reading the same history get the same answer.
 */

/** Candidate shapes for the floor. */
export enum FloorPolicy {
  /** Today's behaviour: floor from the all-time peak. Protection never expires. */
  PEAK = 'PEAK',
  /** Floor from the highest score within a rolling window. An old peak ages out. */
  SUSTAINED_WINDOW = 'SUSTAINED_WINDOW',
  /** Floor from a peak that decays toward the current score at a fixed rate. */
  DECAYING_PEAK = 'DECAYING_PEAK',
  /** Floor applies, except a fault event may push through it. */
  NON_FAULT_ONLY = 'NON_FAULT_ONLY',
  /** No floor at all. The comparison baseline — not a proposal. */
  NONE = 'NONE',
}

export interface ScoreEvent {
  /** Epoch ms. */
  at: number;
  /** The delta the policy layer computed, before any floor. */
  delta: number;
  /** True when this is the agent's own fault — the class `NON_FAULT_ONLY` lets through. */
  isFault: boolean;
}

export interface PolicyParams {
  /** Rolling window for `SUSTAINED_WINDOW`, in days. */
  windowDays?: number;
  /** Points per day the peak decays under `DECAYING_PEAK`. */
  decayPerDay?: number;
  /** Maps a score to its tier floor. Injected so this module never duplicates the DB's table. */
  tierLowerBound: (score: number) => number;
}

export interface Trajectory {
  policy: FloorPolicy;
  /** Score after the last event. */
  finalScore: number;
  /** Total points the agent did NOT pay because the floor caught them. The cost. */
  penaltyAbsorbed: number;
  /** Largest single-event fall the floor cushioned. The benefit. */
  worstSingleDropPrevented: number;
  /** Events whose penalty was absorbed in full — defection that cost nothing. */
  freeDefections: number;
  /** Per-event trace, for a reviewer who wants to see where it diverged. */
  steps: Array<{ at: number; before: number; after: number; absorbed: number }>;
}

const DAY_MS = 86_400_000;
const HARD_MIN = 10;
const HARD_MAX = 10000;

function clampHard(v: number): number {
  return Math.max(HARD_MIN, Math.min(HARD_MAX, v));
}

/**
 * The floor in force at a moment, under a policy.
 *
 * `history` is the score AFTER each prior event, oldest first, paired with its
 * timestamp — everything a peak-like rule needs and nothing it does not.
 */
export function floorAt(
  policy: FloorPolicy,
  history: Array<{ at: number; score: number }>,
  now: number,
  params: PolicyParams,
): number {
  if (policy === FloorPolicy.NONE) return HARD_MIN;
  if (history.length === 0) return HARD_MIN;

  if (policy === FloorPolicy.SUSTAINED_WINDOW) {
    const windowMs = (params.windowDays ?? 90) * DAY_MS;
    const inWindow = history.filter((h) => now - h.at <= windowMs);
    // An empty window means every high is older than the window. The floor is
    // then the hard minimum — which is the entire point of this policy: an old
    // peak stops protecting you.
    if (inWindow.length === 0) return HARD_MIN;
    return params.tierLowerBound(Math.max(...inWindow.map((h) => h.score)));
  }

  if (policy === FloorPolicy.DECAYING_PEAK) {
    const rate = params.decayPerDay ?? 10;
    // The peak decays from the moment it was set, toward the score that
    // followed. A peak reached long ago protects proportionally less.
    let best = HARD_MIN;
    for (const h of history) {
      const ageDays = Math.max(0, (now - h.at) / DAY_MS);
      const decayed = h.score - rate * ageDays;
      if (decayed > best) best = decayed;
    }
    return params.tierLowerBound(Math.max(HARD_MIN, best));
  }

  // PEAK and NON_FAULT_ONLY share the all-time high-water mark; they differ in
  // whether a fault is allowed through it, which is decided per event below.
  return params.tierLowerBound(Math.max(...history.map((h) => h.score)));
}

/**
 * Replay a history under a policy.
 *
 * The hard [10, 10000] clamp always applies — it is not a policy choice, and a
 * floor policy that produced a score outside it would describe a state the
 * engine cannot hold.
 */
export function replay(
  events: ScoreEvent[],
  startScore: number,
  policy: FloorPolicy,
  params: PolicyParams,
  /**
   * When the agent REACHED `startScore`. Required by any age-sensitive policy.
   *
   * An earlier version defaulted this to the first event's timestamp, which
   * silently dated every starting peak to age zero — the MOST protective
   * reading available, and the one that makes `DECAYING_PEAK` indistinguishable
   * from `PEAK`. A comparison whose default answer is "these policies are the
   * same" is worse than one that refuses to guess.
   *
   * Callers that genuinely do not know it should say so and exclude the
   * age-sensitive policies for that agent, rather than pass a plausible value.
   */
  startAt: number,
): Trajectory {
  let score = clampHard(startScore);
  const history: Array<{ at: number; score: number }> = [{ at: startAt, score }];
  const steps: Trajectory['steps'] = [];
  let penaltyAbsorbed = 0;
  let worstSingleDropPrevented = 0;
  let freeDefections = 0;

  for (const e of events) {
    const before = score;
    const requested = clampHard(before + e.delta);

    const floorApplies = !(policy === FloorPolicy.NON_FAULT_ONLY && e.isFault);
    const floor = floorApplies ? floorAt(policy, history, e.at, params) : HARD_MIN;

    const after = Math.max(requested, Math.min(floor, before));
    // `Math.min(floor, before)` matters: a floor ABOVE the current score must
    // not raise it. The floor cushions a fall; it does not hand out points an
    // agent never earned, and a policy that did would be a very different thing.

    const absorbed = after - requested;
    if (absorbed > 0) {
      penaltyAbsorbed += absorbed;
      if (absorbed > worstSingleDropPrevented) worstSingleDropPrevented = absorbed;
      if (after === before) freeDefections++;
    }

    steps.push({ at: e.at, before, after, absorbed });
    score = after;
    history.push({ at: e.at, score });
  }

  return { policy, finalScore: score, penaltyAbsorbed, worstSingleDropPrevented, freeDefections, steps };
}

/**
 * Replay one history under every policy, so the trade is a table rather than an
 * argument.
 */
export function compareAll(
  events: ScoreEvent[],
  startScore: number,
  params: PolicyParams,
  startAt: number,
): Trajectory[] {
  return Object.values(FloorPolicy).map((p) => replay(events, startScore, p, params, startAt));
}
