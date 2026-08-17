/**
 * Module Space — the guarantee under test is that a shadow implementation CANNOT change what the
 * caller receives. Every test here is written so that breaking the property turns it red
 * (LESSONS §6): the shadows return and throw values that would be visible in the result if the
 * boundary ever leaked them.
 */
import {
  defineModuleSpace,
  moduleSpaceFaults,
  incumbentOf,
  shadowsOf,
  runWithShadows,
  ModuleSpace,
  ModuleImplementation,
} from '../src/orchestration/module-space';

/** Monotonic fake clock, so elapsedMs is deterministic and the test is not a timing measurement. */
function fakeClock(): () => number {
  let t = 1_000;
  return () => (t += 10);
}

const incumbent: ModuleImplementation<string, string> = {
  id: 'incumbent-impl',
  authority: 'incumbent',
  run: (input) => `INCUMBENT:${input}`,
};

describe('module space — structure', () => {
  it('refuses a space with no incumbent', () => {
    expect(() =>
      defineModuleSpace<string, string>({
        id: 'no-incumbent',
        description: 'x',
        implementations: [{ id: 'a', authority: 'shadow', run: () => 'a' }],
      }),
    ).toThrow(/no incumbent/);
  });

  it('refuses a space with two incumbents', () => {
    expect(() =>
      defineModuleSpace<string, string>({
        id: 'two-incumbents',
        description: 'x',
        implementations: [
          { id: 'a', authority: 'incumbent', run: () => 'a' },
          { id: 'b', authority: 'incumbent', run: () => 'b' },
        ],
      }),
    ).toThrow(/exactly one implementation may hold authority/);
  });

  it('refuses duplicate implementation ids', () => {
    expect(() =>
      defineModuleSpace<string, string>({
        id: 'dupes',
        description: 'x',
        implementations: [
          incumbent,
          { id: 'incumbent-impl', authority: 'shadow', run: () => 'b' },
        ],
      }),
    ).toThrow(/two implementations with id/);
  });

  it('FLAGS a single-implementation space but does not refuse it', () => {
    const space = defineModuleSpace<string, string>({
      id: 'lonely',
      description: 'a boundary declared before it has a candidate',
      implementations: [incumbent],
    });
    const faults = moduleSpaceFaults(space);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.code).toBe('SINGLE_IMPLEMENTATION');
    // A flag must never be fatal: declaring an existing boundary is how a space legitimately starts.
    expect(faults[0]?.severity).toBe('flag');
  });

  it('stops flagging once a candidate is behind the boundary', () => {
    const space = defineModuleSpace<string, string>({
      id: 'populated',
      description: 'x',
      implementations: [incumbent, { id: 'cand', authority: 'shadow', run: () => 'c' }],
    });
    expect(moduleSpaceFaults(space)).toHaveLength(0);
  });

  it('a retired implementation does not count as a running one', () => {
    const space = defineModuleSpace<string, string>({
      id: 'with-retired',
      description: 'x',
      implementations: [incumbent, { id: 'old', authority: 'retired', run: () => 'old' }],
    });
    expect(moduleSpaceFaults(space).map((f) => f.code)).toEqual(['SINGLE_IMPLEMENTATION']);
    expect(shadowsOf(space)).toHaveLength(0);
    expect(incumbentOf(space).id).toBe('incumbent-impl');
  });
});

describe('module space — a shadow cannot influence the result', () => {
  it('returns the incumbent output even when a shadow returns something else', async () => {
    const space: ModuleSpace<string, string> = defineModuleSpace({
      id: 'hal-signal-extractor',
      description: 'two extractors that disagree; see docs/HAL_CANONICAL_v1.md',
      implementations: [
        incumbent,
        { id: 'loud-shadow', authority: 'shadow', run: (i) => `SHADOW-WINS:${i}` },
      ],
    });

    const run = await runWithShadows(space, 'claim', fakeClock());

    expect(run.output).toBe('INCUMBENT:claim');
    expect(run.output).not.toContain('SHADOW');
    expect(run.incumbentId).toBe('incumbent-impl');
    // The shadow still ran and was recorded — observation is the point, influence is not.
    expect(run.shadows).toHaveLength(1);
    const observed = run.shadows[0];
    expect(observed?.ok).toBe(true);
    if (observed?.ok) expect(observed.output).toBe('SHADOW-WINS:claim');
  });

  it('a throwing shadow is recorded and does not fail the boundary', async () => {
    const space: ModuleSpace<string, string> = defineModuleSpace({
      id: 'throwing',
      description: 'x',
      implementations: [
        incumbent,
        {
          id: 'bad-shadow',
          authority: 'shadow',
          run: () => {
            throw new Error('shadow exploded');
          },
        },
      ],
    });

    const run = await runWithShadows(space, 'claim', fakeClock());

    expect(run.output).toBe('INCUMBENT:claim');
    const observed = run.shadows[0];
    expect(observed?.ok).toBe(false);
    if (observed && !observed.ok) expect(observed.error).toBe('shadow exploded');
  });

  it('when the incumbent throws, the error propagates and NO shadow runs', async () => {
    let shadowRan = false;
    const space: ModuleSpace<string, string> = defineModuleSpace({
      id: 'incumbent-throws',
      description: 'x',
      implementations: [
        {
          id: 'failing-incumbent',
          authority: 'incumbent',
          run: () => {
            throw new Error('incumbent failed');
          },
        },
        {
          id: 'eager-shadow',
          authority: 'shadow',
          run: () => {
            shadowRan = true;
            return 'shadow answer';
          },
        },
      ],
    });

    await expect(runWithShadows(space, 'claim', fakeClock())).rejects.toThrow('incumbent failed');
    // A failed boundary must not be quietly answered by something holding no authority.
    expect(shadowRan).toBe(false);
  });

  it('awaits async implementations on both sides', async () => {
    const space: ModuleSpace<number, number> = defineModuleSpace({
      id: 'async',
      description: 'x',
      implementations: [
        { id: 'inc', authority: 'incumbent', run: async (n) => n * 2 },
        { id: 'sh', authority: 'shadow', run: async (n) => n * 3 },
      ],
    });

    const run = await runWithShadows(space, 7, fakeClock());
    expect(run.output).toBe(14);
    const observed = run.shadows[0];
    if (observed?.ok) expect(observed.output).toBe(21);
  });

  it('does not run retired implementations at all', async () => {
    let retiredRan = false;
    const space: ModuleSpace<string, string> = defineModuleSpace({
      id: 'retired-inert',
      description: 'x',
      implementations: [
        incumbent,
        {
          id: 'gone',
          authority: 'retired',
          run: () => {
            retiredRan = true;
            return 'gone';
          },
        },
      ],
    });

    const run = await runWithShadows(space, 'claim', fakeClock());
    expect(retiredRan).toBe(false);
    expect(run.shadows).toHaveLength(0);
  });
});
