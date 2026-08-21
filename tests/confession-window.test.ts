/**
 * confession-window.test.ts
 *
 * The assertions that matter here are the two strict inequalities:
 *
 *     prompt disclosure  <  late disclosure  <  being caught
 *
 * A test that only checks "a confession is cheaper than being caught" passes
 * happily while the first inequality collapses — and a collapsed first
 * inequality means waiting is free, which is the arbitrage this module exists to
 * close. A collapsed SECOND one is worse: it makes concealment strictly dominant
 * again, which is the failure the confession channel was built to fix.
 */
import {
  LATE_SELF_REPORT_DISCOUNT,
  SELF_REPORT_WINDOW_HOURS,
  classifyDisclosureTiming,
  discountForTiming,
  orderingHolds,
} from '../src/services/confession-window';
import { SELF_REPORT_DISCOUNT, reducedPenalty } from '../src/services/repid-confession';

const T0 = 1_700_000_000_000; // fixed epoch ms; never Date.now()
const H = 3_600_000;

describe('the ordering the whole mechanism rests on', () => {
  it('keeps prompt strictly cheaper than late, and late strictly cheaper than detection', () => {
    expect(orderingHolds(SELF_REPORT_DISCOUNT, LATE_SELF_REPORT_DISCOUNT)).toBe(true);
    expect(SELF_REPORT_DISCOUNT).toBeGreaterThan(0);
    expect(SELF_REPORT_DISCOUNT).toBeLessThan(LATE_SELF_REPORT_DISCOUNT);
    expect(LATE_SELF_REPORT_DISCOUNT).toBeLessThan(1);
  });

  it('rejects the degenerate settings that would silently break it', () => {
    expect(orderingHolds(0, 0.7)).toBe(false); // prompt free → laundering
    expect(orderingHolds(0.4, 1)).toBe(false); // late == detection → hiding dominates
    expect(orderingHolds(0.7, 0.4)).toBe(false); // inverted → waiting pays
    expect(orderingHolds(0.5, 0.5)).toBe(false); // window buys nothing
  });

  /**
   * The ordering asserted on MONEY, not on multipliers. `reducedPenalty` rounds
   * up in magnitude and floors at 1, so a multiplier ordering can survive while
   * the charged amounts tie. Across the real penalty range they must not.
   */
  it('holds on the charged penalty across the realistic range', () => {
    const REAL_PENALTIES = [250, 116, 101, 75, 60, 50, 31, 21, 10, 8, 5];
    for (const detected of REAL_PENALTIES) {
      const prompt = reducedPenalty(detected, SELF_REPORT_DISCOUNT).reduced;
      const late = reducedPenalty(detected, LATE_SELF_REPORT_DISCOUNT).reduced;
      expect(prompt).toBeLessThan(late);
      expect(late).toBeLessThan(detected);
    }
  });

  it('never charges more than detection, even at the degenerate low end', () => {
    for (const detected of [1, 2, 3]) {
      const late = reducedPenalty(detected, LATE_SELF_REPORT_DISCOUNT).reduced;
      expect(late).toBeLessThanOrEqual(detected);
    }
  });
});

describe('classifying the timing', () => {
  it('calls a disclosure inside the window prompt', () => {
    const r = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + 3 * H });
    expect(r.timing).toBe('PROMPT');
    expect(r.ageHours).toBeCloseTo(3, 6);
  });

  it('treats the window edge as inside it', () => {
    const r = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + SELF_REPORT_WINDOW_HOURS * H });
    expect(r.timing).toBe('PROMPT');
  });

  it('calls a disclosure past the edge late', () => {
    const r = classifyDisclosureTiming({
      failureAt: T0,
      confessedAt: T0 + SELF_REPORT_WINDOW_HOURS * H + 1,
    });
    expect(r.timing).toBe('LATE');
  });

  it('honours a window supplied from config', () => {
    const late = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + 5 * H, windowHours: 4 });
    expect(late.timing).toBe('LATE');
    const prompt = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + 5 * H, windowHours: 48 });
    expect(prompt.timing).toBe('PROMPT');
  });
});

describe('evidence honesty', () => {
  it('reports missing timing as NOT_CHECKED and never as PROMPT', () => {
    for (const input of [
      {},
      { failureAt: T0 },
      { confessedAt: T0 },
      { failureAt: null, confessedAt: T0 },
      { failureAt: NaN, confessedAt: T0 },
    ]) {
      const r = classifyDisclosureTiming(input);
      expect(r.timing).toBe('NOT_CHECKED');
      expect(r.ageHours).toBeNull();
    }
  });

  it('prices NOT_CHECKED exactly as LATE while still reporting it differently', () => {
    // Pricing is a decision that has to be made either way; the report is a
    // claim about evidence. Collapsing the second into the first is how "we did
    // not look" becomes "it passed".
    expect(discountForTiming('NOT_CHECKED', SELF_REPORT_DISCOUNT)).toBe(
      discountForTiming('LATE', SELF_REPORT_DISCOUNT),
    );
    expect(discountForTiming('PROMPT', SELF_REPORT_DISCOUNT)).toBe(SELF_REPORT_DISCOUNT);
  });

  it('refuses a disclosure dated before the failure it describes', () => {
    // The obvious use is back-dating a failure into the window, overshot.
    const r = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 - H });
    expect(r.timing).toBe('NOT_CHECKED');
    expect(r.reason).toMatch(/dated before the failure/);
  });

  it('carries a reason a reviewer can audit without recomputing', () => {
    const r = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + 30 * H });
    expect(r.reason).toContain('30.00h');
    expect(r.reason).toContain(`${SELF_REPORT_WINDOW_HOURS}h window`);
  });
});

describe('the arbitrage is actually closed', () => {
  /**
   * The strategy the window exists to defeat: conceal, watch for signs of
   * detection, and confess at the last moment. Model it directly — a confession
   * filed at increasing delays must never get cheaper, and must lose the prompt
   * rate the moment it leaves the window.
   */
  it('waiting never lowers the price, and crossing the window raises it', () => {
    const detected = 116;
    let previous = -Infinity;
    for (const delayHours of [0, 1, 6, 23, 24, 25, 48, 720]) {
      const timing = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + delayHours * H }).timing;
      const charged = reducedPenalty(detected, discountForTiming(timing, SELF_REPORT_DISCOUNT)).reduced;
      expect(charged).toBeGreaterThanOrEqual(previous);
      previous = charged;
    }
    // And the two ends are genuinely different, not merely non-decreasing.
    const atOpen = reducedPenalty(
      detected,
      discountForTiming(classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 }).timing, SELF_REPORT_DISCOUNT),
    ).reduced;
    const wellAfter = reducedPenalty(
      detected,
      discountForTiming(
        classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + 720 * H }).timing,
        SELF_REPORT_DISCOUNT,
      ),
    ).reduced;
    expect(atOpen).toBeLessThan(wellAfter);
  });

  it('leaves disclosure worth doing at every delay — hiding must never dominate', () => {
    const detected = 116;
    for (const delayHours of [0, 24, 25, 1000]) {
      const timing = classifyDisclosureTiming({ failureAt: T0, confessedAt: T0 + delayHours * H }).timing;
      const charged = reducedPenalty(detected, discountForTiming(timing, SELF_REPORT_DISCOUNT)).reduced;
      expect(charged).toBeLessThan(detected);
    }
  });
});
