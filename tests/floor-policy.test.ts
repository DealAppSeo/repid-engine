/**
 * floor-policy.test.ts
 *
 * The point of this module is to make one trade visible: a floor that absorbs
 * penalty is a floor that protects a career, and also a floor that makes
 * defection free. Every policy sits somewhere on that line. These tests pin the
 * ends of the line and the shape in between — and pin the property that a floor
 * cushions a fall without ever handing out points.
 */
import {
  FloorPolicy,
  compareAll,
  floorAt,
  replay,
  type PolicyParams,
  type ScoreEvent,
} from '../src/services/floor-policy';

/** The canonical five-tier lower bounds, injected rather than duplicated. */
const tierLowerBound = (s: number): number =>
  s >= 8000 ? 8000 : s >= 5000 ? 5000 : s >= 1000 ? 1000 : s >= 500 ? 500 : 0;

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const params: PolicyParams = { tierLowerBound, windowDays: 90, decayPerDay: 10 };

/** N confident faults, one per day, of the magnitude the measured triad produced. */
function faults(n: number, delta = -116, isFault = true): ScoreEvent[] {
  return Array.from({ length: n }, (_, i) => ({ at: T0 + i * DAY, delta, isFault }));
}

describe('the measured behaviour, reproduced — PEAK makes defection free', () => {
  it('absorbs everything below the tier floor once the peak is set', () => {
    const t = replay(faults(25), 10000, FloorPolicy.PEAK, params, T0);
    // The score cannot fall below the VETERAN floor, exactly as measured live.
    expect(t.finalScore).toBe(8000);
    expect(t.penaltyAbsorbed).toBeGreaterThan(0);
    // And the tail events cost precisely nothing — the career invariant break.
    expect(t.freeDefections).toBeGreaterThan(0);
  });

  it('charges the full penalty while the agent is still above the floor', () => {
    const t = replay(faults(5), 10000, FloorPolicy.PEAK, params, T0);
    expect(t.finalScore).toBe(10000 - 5 * 116);
    expect(t.penaltyAbsorbed).toBe(0);
    expect(t.freeDefections).toBe(0);
  });
});

describe('NONE is the baseline — it protects nothing and nothing is free', () => {
  it('absorbs no penalty at all', () => {
    const t = replay(faults(25), 10000, FloorPolicy.NONE, params, T0);
    expect(t.penaltyAbsorbed).toBe(0);
    expect(t.freeDefections).toBe(0);
    expect(t.finalScore).toBeLessThan(8000);
  });

  it('still respects the hard floor of 10, which is not a policy choice', () => {
    const t = replay(faults(500), 10000, FloorPolicy.NONE, params, T0);
    expect(t.finalScore).toBe(10);
  });
});

describe('the trade, stated as an ordering', () => {
  /**
   * This is the whole decision in one assertion. More absorption means more
   * career protection AND more free defection. A policy cannot buy one without
   * the other, and any proposal claiming otherwise is worth re-reading.
   */
  it('absorption and free defection move together across policies', () => {
    const all = compareAll(faults(25), 10000, params, T0);
    const byPolicy = Object.fromEntries(all.map((t) => [t.policy, t]));

    expect(byPolicy[FloorPolicy.NONE]!.penaltyAbsorbed).toBe(0);
    expect(byPolicy[FloorPolicy.PEAK]!.penaltyAbsorbed).toBeGreaterThan(0);

    for (const t of all) {
      if (t.penaltyAbsorbed === 0) expect(t.freeDefections).toBe(0);
      if (t.freeDefections > 0) expect(t.penaltyAbsorbed).toBeGreaterThan(0);
    }
  });

  it('reports the benefit as well as the cost, so neither is quoted alone', () => {
    const t = replay(faults(25), 10000, FloorPolicy.PEAK, params, T0);
    // The reason the floor exists: it cushioned a fall.
    expect(t.worstSingleDropPrevented).toBeGreaterThan(0);
  });
});

describe('SUSTAINED_WINDOW — an old peak stops protecting you', () => {
  it('protects while the peak is inside the window', () => {
    const t = replay(faults(3), 10000, FloorPolicy.SUSTAINED_WINDOW, params, T0);
    expect(t.finalScore).toBe(10000 - 3 * 116);
  });

  it('lets the score fall once every high has aged out of the window', () => {
    // One fault now, then one long after the window closed.
    const events: ScoreEvent[] = [
      { at: T0, delta: -116, isFault: true },
      { at: T0 + 200 * DAY, delta: -5000, isFault: true },
    ];
    const windowed = replay(events, 10000, FloorPolicy.SUSTAINED_WINDOW, params, T0);
    const peak = replay(events, 10000, FloorPolicy.PEAK, params, T0);
    // Under PEAK the second event is cushioned at the VETERAN floor; under a
    // window whose highs have expired it is not.
    expect(peak.finalScore).toBe(8000);
    expect(windowed.finalScore).toBeLessThan(peak.finalScore);
  });
});

describe('DECAYING_PEAK — protection erodes rather than expiring', () => {
  it('protects less as the peak ages', () => {
    const near: ScoreEvent[] = [{ at: T0 + 1 * DAY, delta: -5000, isFault: true }];
    const far: ScoreEvent[] = [{ at: T0 + 300 * DAY, delta: -5000, isFault: true }];
    const a = replay(near, 10000, FloorPolicy.DECAYING_PEAK, params, T0);
    const b = replay(far, 10000, FloorPolicy.DECAYING_PEAK, params, T0);
    expect(b.finalScore).toBeLessThan(a.finalScore);
  });

  it('never protects more than PEAK would', () => {
    // A decayed peak is by construction no higher than the true peak, so this
    // policy is always weakly cheaper. If it ever were not, the decay is
    // producing points from nowhere.
    for (const n of [1, 5, 25]) {
      const d = replay(faults(n), 10000, FloorPolicy.DECAYING_PEAK, params, T0);
      const p = replay(faults(n), 10000, FloorPolicy.PEAK, params, T0);
      expect(d.penaltyAbsorbed).toBeLessThanOrEqual(p.penaltyAbsorbed);
    }
  });
});

describe('NON_FAULT_ONLY — the floor stops protecting the agent from itself', () => {
  it('lets a fault push straight through the floor', () => {
    const t = replay(faults(25), 10000, FloorPolicy.NON_FAULT_ONLY, params, T0);
    expect(t.finalScore).toBeLessThan(8000);
    expect(t.penaltyAbsorbed).toBe(0);
  });

  it('still cushions events that are NOT the agent fault', () => {
    // Infra and counterparty failures are exactly what a career-protecting
    // floor should absorb; agent fault is exactly what it should not.
    const notMyFault = faults(25, -116, false);
    const t = replay(notMyFault, 10000, FloorPolicy.NON_FAULT_ONLY, params, T0);
    expect(t.finalScore).toBe(8000);
    expect(t.penaltyAbsorbed).toBeGreaterThan(0);
  });
});

describe('a floor cushions a fall — it never hands out points', () => {
  /**
   * The dangerous mistake in any of these policies: computing a floor above the
   * agent's current score and raising it. That converts a protection into a
   * grant, and an agent could climb by doing nothing.
   */
  it('never raises a score that is already below its floor', () => {
    // Start well below the floor a past peak would imply, then do nothing bad.
    const events: ScoreEvent[] = [{ at: T0, delta: 0, isFault: false }];
    for (const policy of Object.values(FloorPolicy)) {
      const t = replay(events, 3000, policy, params, T0);
      expect(t.finalScore).toBe(3000);
    }
  });

  it('never lets any policy exceed the hard ceiling', () => {
    const gains: ScoreEvent[] = Array.from({ length: 50 }, (_, i) => ({
      at: T0 + i * DAY,
      delta: 500,
      isFault: false,
    }));
    for (const policy of Object.values(FloorPolicy)) {
      expect(replay(gains, 9000, policy, params, T0).finalScore).toBe(10000);
    }
  });
});

describe('floorAt', () => {
  it('returns the hard minimum when there is no history to derive a peak from', () => {
    for (const policy of Object.values(FloorPolicy)) {
      expect(floorAt(policy, [], T0, params)).toBe(10);
    }
  });

  it('derives the floor from the injected tier table, never a local copy', () => {
    const history = [{ at: T0, score: 8200 }];
    expect(floorAt(FloorPolicy.PEAK, history, T0, params)).toBe(8000);
    // A different table gives a different answer — proving nothing is hardcoded.
    expect(floorAt(FloorPolicy.PEAK, history, T0, { ...params, tierLowerBound: () => 123 })).toBe(123);
  });
});
