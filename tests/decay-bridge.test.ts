/**
 * Option C step 1 — decay reaches the path that actually runs.
 *
 * Decision: REPID_TWO_PATH_DIVERGENCE.md Option C (Sean, 2026-08-03). Port the
 * dormant layers into the live pipeline one at a time, each flagged, each measured
 * in shadow before enforce.
 *
 * The property that matters most is SHADOW MUST NOT MOVE A NUMBER. Decay is
 * computed from 30-day activity, so enabling it applies 30+ days of absent decay in
 * one step per agent, across the whole roster, visible on every badge and on-chain
 * via ERC-8004. If shadow leaks even a point, the measurement meant to prevent that
 * becomes the event itself.
 */

import {
  assessDecay,
  decayedScoreFor,
  decayMetadata,
  parseDecayMode,
} from '../src/scoring/decay-bridge';

describe('mode parsing — off unless explicitly asked', () => {
  it('defaults to off, and only the exact words count', () => {
    expect(parseDecayMode(undefined)).toBe('off');
    expect(parseDecayMode('')).toBe('off');
    expect(parseDecayMode('true')).toBe('off');
    expect(parseDecayMode('1')).toBe('off');
    expect(parseDecayMode('on')).toBe('off');
    expect(parseDecayMode('shadow')).toBe('shadow');
    expect(parseDecayMode('enforce')).toBe('enforce');
  });

  it('is case and whitespace tolerant for the real values', () => {
    expect(parseDecayMode('  ENFORCE ')).toBe('enforce');
    expect(parseDecayMode('Shadow')).toBe('shadow');
  });
});

describe('off — completely inert', () => {
  it('changes nothing and reports nothing to remove', () => {
    const a = assessDecay({ currentRepid: 1611, activity30d: 0, mode: 'off' });
    expect(a.decayed_to).toBe(1611);
    expect(a.would_remove).toBe(0);
    expect(a.factor).toBe(1);
    expect(a.applied).toBe(false);
    expect(decayedScoreFor(a)).toBe(1611);
  });
});

describe('shadow — computes the counterfactual, moves nothing', () => {
  const a = () => assessDecay({ currentRepid: 1611, activity30d: 0, mode: 'shadow' });

  it('computes a real decay figure', () => {
    expect(a().would_remove).toBeGreaterThan(0);
    expect(a().decayed_to).toBeLessThan(1611);
    expect(a().factor).toBeLessThan(1);
  });

  it('THE LOAD-BEARING PROPERTY: the score actually used is undecayed', () => {
    expect(decayedScoreFor(a())).toBe(1611);
    expect(a().applied).toBe(false);
  });

  it('records enough in metadata to measure the run afterwards', () => {
    const m = decayMetadata(a()) as { decay: Record<string, unknown> };
    expect(m.decay.mode).toBe('shadow');
    expect(m.decay.applied).toBe(false);
    expect(m.decay.from).toBe(1611);
    expect(Number(m.decay.would_remove)).toBeGreaterThan(0);
    expect(Number(m.decay.decayed_to)).toBeLessThan(1611);
  });
});

describe('enforce — the only mode that moves a score', () => {
  const a = () => assessDecay({ currentRepid: 1611, activity30d: 0, mode: 'enforce' });

  it('applies the decayed score', () => {
    expect(a().applied).toBe(true);
    expect(decayedScoreFor(a())).toBe(a().decayed_to);
    expect(decayedScoreFor(a())).toBeLessThan(1611);
  });

  it('an ACTIVE agent barely decays — decay punishes idleness, not participation', () => {
    const idle = assessDecay({ currentRepid: 1611, activity30d: 0, mode: 'enforce' });
    const busy = assessDecay({ currentRepid: 1611, activity30d: 60, mode: 'enforce' });
    expect(busy.would_remove).toBeLessThan(idle.would_remove);
  });

  it('does not report applied when there is nothing to remove', () => {
    // At the floor there is no room to decay, so `applied` must stay false rather
    // than claiming an action that changed nothing.
    const atFloor = assessDecay({ currentRepid: 10, activity30d: 0, mode: 'enforce' });
    expect(atFloor.would_remove).toBe(0);
    expect(atFloor.applied).toBe(false);
  });
});

describe('bounds and bad input', () => {
  it('never decays below the RepID floor of 10', () => {
    for (const score of [10, 11, 20, 100]) {
      const a = assessDecay({ currentRepid: score, activity30d: 0, mode: 'enforce' });
      expect(a.decayed_to).toBeGreaterThanOrEqual(10);
    }
  });

  it('treats a non-finite activity count as zero rather than producing NaN', () => {
    const a = assessDecay({ currentRepid: 1611, activity30d: NaN, mode: 'enforce' });
    expect(a.activity_30d).toBe(0);
    expect(Number.isFinite(a.decayed_to)).toBe(true);
    expect(Number.isFinite(a.would_remove)).toBe(true);
  });

  it('would_remove is never negative — decay only ever takes away', () => {
    for (const [score, act] of [[10, 0], [1000, 100], [10000, 0], [500, 999]] as const) {
      const a = assessDecay({ currentRepid: score, activity30d: act, mode: 'enforce' });
      expect(a.would_remove).toBeGreaterThanOrEqual(0);
    }
  });

  it('a higher score has more absolute decay than a lower one at equal idleness', () => {
    const low = assessDecay({ currentRepid: 100, activity30d: 0, mode: 'enforce' });
    const high = assessDecay({ currentRepid: 9000, activity30d: 0, mode: 'enforce' });
    expect(high.would_remove).toBeGreaterThan(low.would_remove);
  });
});
