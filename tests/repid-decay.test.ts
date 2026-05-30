/**
 * Unit tests for the RepID dormancy decay pure function (sprint 2026-05-29).
 * Hand-computed cases for: near-zero active decay, floor protection,
 * decaying-decay easing, and skip-and-flag.
 */
import { decayRepid, tierLowerBound, sustainedActivityModifier } from '../src/services/repid-decay';

const NOW = Date.parse('2026-05-29T00:00:00.000Z');
const weeksAgo = (w: number) => new Date(NOW - w * 7 * 24 * 60 * 60 * 1000).toISOString();

describe('tierLowerBound', () => {
  it('maps repid to its tier lower bound', () => {
    expect(tierLowerBound(2280)).toBe(1000); // ESTABLISHED
    expect(tierLowerBound(600)).toBe(500);   // EARNING
    expect(tierLowerBound(9000)).toBe(8000); // VETERAN
    expect(tierLowerBound(5000)).toBe(5000); // AUTONOMOUS lower edge
    expect(tierLowerBound(50)).toBe(0);      // PROBATIONARY
  });
});

describe('sustainedActivityModifier (decaying-decay)', () => {
  it('eases the rate with sustained weeks, clamped to [0.25, 1]', () => {
    expect(sustainedActivityModifier(0)).toBe(1);
    expect(sustainedActivityModifier(10)).toBeCloseTo(0.8, 10);
    expect(sustainedActivityModifier(50)).toBe(0.25); // clamped floor
    expect(sustainedActivityModifier(100)).toBe(0.25);
  });
});

describe('decayRepid', () => {
  it('active agent (idle < 1 week) → near-zero decay', () => {
    const r = decayRepid({ current_repid: 2000, decay_rate: 0.0015, last_active_at: weeksAgo(0.5), sustained_activity_weeks: 0, lifecycle_status: 'active' }, NOW);
    expect(r.skip).toBeUndefined();
    expect(r.decay_amount).toBeLessThanOrEqual(2); // ~0
    expect(r.repid_after).toBeGreaterThanOrEqual(1998);
  });

  it('dormant agent decays by (1-rate)^weeks (hand-computed)', () => {
    // base_rate 0.01, modifier 1, weeks_idle 10 → 1200*(0.99)^10 = 1085.25 → 1085, floor 1000
    const r = decayRepid({ current_repid: 1200, decay_rate: 0.01, last_active_at: weeksAgo(10), sustained_activity_weeks: 0, lifecycle_status: 'active' }, NOW);
    expect(r.effective_rate).toBeCloseTo(0.01, 10);
    expect(r.weeks_idle).toBeCloseTo(10, 6);
    expect(r.repid_after).toBe(1085);
    expect(r.decay_amount).toBe(115);
    expect(r.floored).toBe(false);
  });

  it('FLOOR protects earned tier standing (never below current tier lower bound)', () => {
    // 1050 ESTABLISHED, rate 0.05, weeks 20 → 1050*(0.95)^20 = 376 < floor 1000 → clamps to 1000
    const r = decayRepid({ current_repid: 1050, decay_rate: 0.05, last_active_at: weeksAgo(20), sustained_activity_weeks: 0, lifecycle_status: 'active' }, NOW);
    expect(r.floor).toBe(1000);
    expect(r.repid_after).toBe(1000);
    expect(r.decay_amount).toBe(50);
    expect(r.floored).toBe(true);
  });

  it('DECAYING-DECAY: sustained activity eases the rate → less decay', () => {
    const common = { current_repid: 3000, decay_rate: 0.02, last_active_at: weeksAgo(10), lifecycle_status: 'active' as const };
    const fresh = decayRepid({ ...common, sustained_activity_weeks: 0 }, NOW);
    const veteran = decayRepid({ ...common, sustained_activity_weeks: 50 }, NOW); // modifier clamped 0.25
    expect(veteran.effective_rate).toBeLessThan(fresh.effective_rate);
    expect(veteran.decay_amount).toBeLessThan(fresh.decay_amount);
    expect(veteran.sustained_modifier).toBe(0.25);
  });

  it('SKIP-AND-FLAG: null last_active_at → indeterminate_activity, no decay', () => {
    const r = decayRepid({ current_repid: 2280, decay_rate: 0.0015, last_active_at: null, lifecycle_status: 'active' }, NOW);
    expect(r.skip).toBe('indeterminate_activity');
    expect(r.repid_after).toBe(2280);
    expect(r.decay_amount).toBe(0);
  });

  it('SKIP-AND-FLAG guard: non-active status is never decayed', () => {
    const r = decayRepid({ current_repid: 5000, decay_rate: 0.0015, last_active_at: weeksAgo(40), lifecycle_status: 'test_only' }, NOW);
    expect(r.skip).toBe('non_active_status');
    expect(r.decay_amount).toBe(0);
  });

  it('falls back to created_at tenure when sustained_activity_weeks absent', () => {
    const r = decayRepid({ current_repid: 3000, decay_rate: 0.02, last_active_at: weeksAgo(10), created_at: weeksAgo(60), lifecycle_status: 'active' }, NOW);
    // tenure 60w → modifier clamped to 0.25
    expect(r.sustained_modifier).toBe(0.25);
    expect(r.effective_rate).toBeCloseTo(0.005, 10);
  });
});
