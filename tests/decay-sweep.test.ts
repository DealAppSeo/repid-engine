/**
 * decay-sweep.test.ts — gates the decay shadow sweep.
 *
 * The sweep walks every agent on the roster. That makes it the only piece of this
 * codebase that touches all 176 agents in one pass, so the property that matters
 * is not "does it compute decay correctly" — `layers/decay.ts` owns that — but
 * "can it ever move a score". One wrong flag on a job with roster-wide reach moves
 * every agent at once, visible on every badge and, through ERC-8004, on-chain.
 *
 * So the first block is the safety block, and it asserts the thing by setting the
 * environment to `enforce` and checking the sweep ignores it. A test that only ran
 * under the default would pass forever without covering the case that hurts.
 *
 * Defence in depth: this is the second of three. The mode is hard-coded in
 * `observeAgent`, asserted here, and the table carries `check (mode = 'shadow')`
 * so the database refuses an enforcing row even if both of the first two fail.
 */
import {
  observeAgent,
  summarise,
  paramsRuler,
  type DecaySweepObservation,
} from '../src/scoring/decay-sweep';

const AGENT = '11111111-1111-4111-8111-111111111111';

const obs = (over: Partial<DecaySweepObservation> = {}): DecaySweepObservation => ({
  agent_id: AGENT,
  mode: 'shadow',
  repid_before: 1000,
  decayed_to: 1000,
  would_remove: 0,
  factor: 1,
  activity_30d: 0,
  ...over,
});

describe('the sweep cannot enforce', () => {
  const original = process.env.REPID_DECAY_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.REPID_DECAY_MODE;
    else process.env.REPID_DECAY_MODE = original;
  });

  it('stays in shadow even when the environment says enforce', () => {
    process.env.REPID_DECAY_MODE = 'enforce';
    const o = observeAgent({ id: AGENT, current_repid: 1000, activity_30d: 0 });
    expect(o).not.toBeNull();
    expect(o!.mode).toBe('shadow');
  });

  it('still reports a non-zero counterfactual under enforce — it measures, it just does not apply', () => {
    // The dangerous bug is not "sweep enforces". It is "sweep silently measures
    // nothing", which looks identical to a healthy sweep of a healthy roster.
    process.env.REPID_DECAY_MODE = 'enforce';
    const idle = observeAgent({ id: AGENT, current_repid: 9000, activity_30d: 0 })!;
    expect(idle.mode).toBe('shadow');
    expect(idle.would_remove).toBeGreaterThan(0);
    expect(idle.decayed_to).toBeLessThan(idle.repid_before);
  });

  it('produces the same observation under off, shadow and enforce', () => {
    const read = (mode: string) => {
      process.env.REPID_DECAY_MODE = mode;
      return observeAgent({ id: AGENT, current_repid: 4000, activity_30d: 0 })!;
    };
    const off = read('off');
    const shadow = read('shadow');
    const enforce = read('enforce');
    expect(shadow).toEqual(off);
    expect(enforce).toEqual(off);
  });
});

describe('observeAgent', () => {
  it('decays an idle agent harder than an active one', () => {
    const idle = observeAgent({ id: AGENT, current_repid: 5000, activity_30d: 0 })!;
    const busy = observeAgent({ id: AGENT, current_repid: 5000, activity_30d: 50 })!;
    expect(idle.would_remove).toBeGreaterThanOrEqual(busy.would_remove);
  });

  it('never reports a negative would_remove', () => {
    for (const repid of [10, 100, 1000, 10000]) {
      for (const activity of [0, 1, 50]) {
        const o = observeAgent({ id: AGENT, current_repid: repid, activity_30d: activity })!;
        expect(o.would_remove).toBeGreaterThanOrEqual(0);
        expect(o.decayed_to).toBeLessThanOrEqual(o.repid_before);
      }
    }
  });

  it('treats a null activity as zero rather than skipping the agent', () => {
    // Skipping would quietly drop agents from the cohort the sweep exists to measure.
    const o = observeAgent({ id: AGENT, current_repid: 800, activity_30d: null });
    expect(o).not.toBeNull();
    expect(o!.activity_30d).toBe(0);
  });

  it('returns null for an agent with no score, rather than inventing one', () => {
    expect(observeAgent({ id: AGENT, current_repid: null, activity_30d: 0 })).toBeNull();
  });
});

describe('summarise', () => {
  it('separates "observed" from "would bite" — they are different questions', () => {
    const s = summarise([
      obs({ would_remove: 0 }),
      obs({ would_remove: 12 }),
      obs({ would_remove: 200 }),
    ]);
    expect(s.observed).toBe(3);
    expect(s.would_bite).toBe(2);
    expect(s.total_points_at_risk).toBe(212);
    expect(s.max_would_remove).toBe(200);
  });

  it('counts the zero-activity cohort, which is the whole reason the sweep exists', () => {
    const s = summarise([
      obs({ activity_30d: 0 }),
      obs({ activity_30d: 0 }),
      obs({ activity_30d: 7 }),
    ]);
    expect(s.zero_activity).toBe(2);
  });

  it('reports zeroes for an empty set without throwing', () => {
    expect(summarise([])).toEqual({
      observed: 0,
      would_bite: 0,
      zero_activity: 0,
      total_points_at_risk: 0,
      max_would_remove: 0,
    });
  });
});

describe('paramsRuler — the ruler, per lesson 8', () => {
  it('is null when no salt is configured, rather than a fake ruler', () => {
    expect(paramsRuler(undefined)).toBeNull();
    expect(paramsRuler('')).toBeNull();
  });

  it('is stable for the same salt, so two sweeps can be compared', () => {
    expect(paramsRuler('salt-a')).toBe(paramsRuler('salt-a'));
  });

  it('does not leak the constants it fingerprints', () => {
    const r = paramsRuler('salt-a')!;
    expect(r).toMatch(/^[0-9a-f]{16}$/);
    // The tuned values must not be recoverable from the token by inspection.
    expect(r).not.toContain('.');
  });
});
