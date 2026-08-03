/**
 * RepID clamp — the range the database actually accepts.
 *
 * repid_agents carries CHECK (current_repid >= 10 AND current_repid <= 10000).
 * The documented pipeline clamped to exactly that. The LIVE pipeline did not:
 * runScoreEvent had no clamp at all, and applyValidationEvent used
 * Math.max(0, …) — floor 0 against a DB floor of 10, and no ceiling.
 *
 * The consequence is backwards from what you want. A clamp turns an extreme
 * penalty into "you hit the floor". An unclamped value gets REJECTED by the CHECK
 * (23514) and the score does not move at all — so the penalty big enough to
 * matter was the one most likely to be silently dropped, and an agent at 9,990
 * taking +30 failed to write instead of capping.
 *
 * Measured 2026-08-02: runScoreEvent wrote all 35,501 events of the prior 30 days.
 * This was the live path, unclamped, throughout.
 */

import {
  clampRepid,
  clampRepidLoud,
  REPID_MIN,
  REPID_MAX,
} from '../src/scoring/repid-clamp';

describe('the bounds match the database exactly', () => {
  it('is [10, 10000] — the same numbers as repid_agents_current_repid_check', () => {
    expect(REPID_MIN).toBe(10);
    expect(REPID_MAX).toBe(10000);
  });
});

describe('in-range values are untouched', () => {
  it.each([10, 11, 500, 1000, 1611, 9999, 10000])('passes %i through unchanged', (v) => {
    const r = clampRepid(v);
    expect(r.value).toBe(v);
    expect(r.clamped).toBe(false);
  });
});

describe('the floor — an extreme penalty lands on 10, it does not vanish', () => {
  it('clamps below the minimum rather than letting the write be rejected', () => {
    const r = clampRepid(4);
    expect(r.value).toBe(10);
    expect(r.clamped).toBe(true);
    expect(r.bound).toBe('floor');
  });

  it('handles the old floor-0 case that the DB would have rejected', () => {
    // Math.max(0, …) produced 0, which fails CHECK (>= 10).
    expect(clampRepid(0).value).toBe(10);
  });

  it('handles a negative result', () => {
    expect(clampRepid(-500).value).toBe(10);
  });
});

describe('the ceiling — 9,990 + 30 caps, it does not fail', () => {
  it('clamps above the maximum', () => {
    const r = clampRepid(10020);
    expect(r.value).toBe(10000);
    expect(r.clamped).toBe(true);
    expect(r.bound).toBe('ceiling');
  });

  it('is the exact case an agent near the cap hits', () => {
    expect(clampRepid(9990 + 30).value).toBe(10000);
  });
});

describe('rounding', () => {
  it('rounds before clamping', () => {
    expect(clampRepid(1611.4).value).toBe(1611);
    expect(clampRepid(1611.6).value).toBe(1612);
  });

  it('never emits a fractional score — current_repid is an integer column', () => {
    for (const v of [10.5, 999.99, 10000.4, -0.5]) {
      expect(Number.isInteger(clampRepid(v).value)).toBe(true);
    }
  });

  // A non-finite score means something upstream is broken. Both directions are
  // then a guess, and the guesses are not symmetric: mapping Infinity to the
  // CEILING would hand an agent a perfect reputation on the back of a NaN, which
  // is the one outcome worth avoiding. So every non-finite input lands on the
  // floor — the fail-safe direction — and only -Infinity does so "correctly".
  it('sends every non-finite value to the floor, never the ceiling', () => {
    expect(clampRepid(NaN).value).toBe(REPID_MIN);
    expect(clampRepid(Infinity).value).toBe(REPID_MIN);
    expect(clampRepid(-Infinity).value).toBe(REPID_MIN);
  });
});

describe('a clamp that fires is announced', () => {
  it('warns on the floor, naming the agent and what the old behaviour was', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const v = clampRepidLoud(-20, { agentId: 'agent-1', eventType: 'SERVICE_SATISFIED' });
    expect(v).toBe(10);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FLOOR HIT'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent-1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SERVICE_SATISFIED'));
    warn.mockRestore();
  });

  it('warns on the ceiling', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clampRepidLoud(99999, { agentId: 'a' })).toBe(REPID_MAX);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CEILING HIT'));
    warn.mockRestore();
  });

  it('stays silent for an ordinary in-range score', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clampRepidLoud(1611, { agentId: 'a' })).toBe(1611);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
