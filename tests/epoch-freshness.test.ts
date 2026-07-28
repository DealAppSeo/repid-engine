/**
 * Each test NAMES the property it pins, so a mutation battery can be graded by which test dies
 * rather than by how many do — the check Beat 52 learned to make after two distinct guards proved
 * indistinguishable under bare `ok === false` assertions.
 */
import {
  checkEpochFreshness, derivedMaxEpochLag, MAX_OBSERVATIONS,
  type AnchorObservation,
} from '../src/memory/epoch-freshness';

const R = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const obs = (epoch: number, root = R(epoch), source = 'chain'): AnchorObservation => ({ epoch, root, source });
const stream = (from: number, to: number): AnchorObservation[] => {
  const out: AnchorObservation[] = [];
  for (let e = from; e <= to; e++) out.push(obs(e));
  return out;
};

describe('epoch freshness — the withheld-epoch check', () => {
  it('LATEST: a publication at the newest observed epoch is fresh', () => {
    const v = checkEpochFreshness({ epoch: 10, root: R(10) }, stream(1, 10), { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.latestKnownEpoch).toBe(10);
    expect(v.epochLag).toBe(0);
  });

  it('WITHHOLDING: a genuine, correctly-anchored epoch is REFUSED once a later one has been observed', () => {
    // The whole attack: every artifact authentic, only the set incomplete.
    const v = checkEpochFreshness({ epoch: 7, root: R(7) }, stream(1, 10), { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
    expect(v.epochLag).toBe(3);
    expect(v.latestKnownSource).toBe('chain');
  });

  it('LAG BOUND: the same publication is accepted when the policy allows that much lag', () => {
    const v = checkEpochFreshness({ epoch: 7, root: R(7) }, stream(1, 10), { maxEpochLag: 3 });
    expect(v.ok).toBe(true);
    expect(v.epochLag).toBe(3);
  });

  it('LAG BOUND IS EXACT: one epoch beyond the bound is refused', () => {
    const v = checkEpochFreshness({ epoch: 6, root: R(6) }, stream(1, 10), { maxEpochLag: 3 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
    expect(v.epochLag).toBe(4);
  });

  it('AHEAD IS NOT STALE: a publication newer than anything observed is not refused for lag', () => {
    const v = checkEpochFreshness({ epoch: 12, root: R(12) }, stream(1, 10), { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.epochLag).toBe(-2);
  });

  it('FAIL-CLOSED: with no observation at all, freshness is unknown and therefore refused', () => {
    const v = checkEpochFreshness({ epoch: 7, root: R(7) }, [], { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('no-usable-observation');
    expect(v.latestKnownEpoch).toBeNull();
    expect(v.epochLag).toBeNull();
  });

  it('OPT-OUT MOVES THE VERDICT: requireObservation:false accepts the weaker claim, not just a quieter one', () => {
    const v = checkEpochFreshness({ epoch: 7, root: R(7) }, [], { maxEpochLag: 0, requireObservation: false });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.latestKnownEpoch).toBeNull();
  });

  it('OPT-OUT IS NOT A BYPASS: it does not rescue a malformed epoch', () => {
    const v = checkEpochFreshness({ epoch: -1, root: R(1) }, [], { maxEpochLag: 0, requireObservation: false });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('presented-epoch-not-a-safe-integer');
  });

  it('EQUIVOCATION: two roots asserted for one epoch is refused, with both sources named', () => {
    const feed = [obs(9, R(9), 'chain'), obs(9, R(99), 'peer-b')];
    const v = checkEpochFreshness({ epoch: 5, root: R(5) }, feed, { maxEpochLag: 10 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('epoch-equivocation');
    expect(v.equivocation).toEqual({ epoch: 9, rootA: R(9), rootB: R(99), sourceA: 'chain', sourceB: 'peer-b' });
  });

  it('EQUIVOCATION AGAINST THE PRESENTATION: a different root for the presented epoch is caught', () => {
    const v = checkEpochFreshness({ epoch: 4, root: R(4) }, [obs(4, R(44), 'chain')], { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('epoch-equivocation');
    expect(v.equivocation?.sourceA).toBe('presentation');
  });

  it('CASE-INSENSITIVE ROOTS: the same root in different hex case is not an equivocation', () => {
    const v = checkEpochFreshness({ epoch: 4, root: '0xABCD' }, [obs(4, '0xabcd', 'chain')], { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.equivocation).toBeNull();
  });

  it('NOISE CANNOT REFUSE: malformed observations are skipped and counted, not verdict-bearing', () => {
    const feed = [
      { epoch: 'x', root: R(1), source: 'junk' },
      { epoch: 1.5, root: R(1), source: 'junk' },
      { epoch: -3, root: R(1), source: 'junk' },
      { epoch: 2, root: '', source: 'junk' },
      null,
      obs(10),
    ] as unknown as AnchorObservation[];
    const v = checkEpochFreshness({ epoch: 10, root: R(10) }, feed, { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.skippedObservations).toBe(5);
    expect(v.latestKnownEpoch).toBe(10);
  });

  it('NOISE STILL FAILS CLOSED: an all-garbage feed yields no evidence, and no evidence refuses', () => {
    const feed = [null, undefined, 7, 'x', {}] as unknown as AnchorObservation[];
    const v = checkEpochFreshness({ epoch: 3, root: R(3) }, feed, { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.skippedObservations).toBe(5);
    expect(v.reasons).toContain('no-usable-observation');
  });

  it.each([[-1], [-5], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 2]])(
    'EPOCH IS A TIME: a presented epoch of %p is refused and the clause is a TERM of ok',
    (epoch) => {
      const v = checkEpochFreshness({ epoch: epoch as number, root: R(1) }, stream(1, 3), { maxEpochLag: 100 });
      expect(v.reasons).toContain('presented-epoch-not-a-safe-integer');
      expect(v.ok).toBe(false);   // Beat 56: a clause computed, named, and not read is the defect
      expect(v.epochLag).toBeNull();
    },
  );

  it('ROOT IS REQUIRED: a publication with no root is refused', () => {
    const v = checkEpochFreshness({ epoch: 3, root: '' }, stream(1, 3), { maxEpochLag: 100 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('presented-root-malformed');
  });

  it('BOUNDED BEFORE THE SCAN: an oversized stream is refused even though scanning it would ACCEPT', () => {
    // Every entry is a valid observation of the presented epoch, so a run that scanned the stream
    // would return ok:true. Refusal is therefore evidence the cap fired ahead of the loop — the
    // Beat 53 property: a bound applied after the work is not a bound.
    const huge: AnchorObservation[] = new Array(MAX_OBSERVATIONS + 1).fill(obs(1));
    const v = checkEpochFreshness({ epoch: 1, root: R(1) }, huge, { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('observation-stream-too-large');
    expect(v.latestKnownEpoch).toBeNull();   // nothing was read

    // ...and one below the cap, the same stream is accepted, so the test is not passing vacuously.
    const atCap: AnchorObservation[] = new Array(MAX_OBSERVATIONS).fill(obs(1));
    expect(checkEpochFreshness({ epoch: 1, root: R(1) }, atCap, { maxEpochLag: 0 }).ok).toBe(true);
  });

  it('NOT AN ARRAY: a stream that is not a stream is refused', () => {
    const v = checkEpochFreshness({ epoch: 1, root: R(1) }, { epoch: 1 } as unknown as AnchorObservation[], { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('observations-not-an-array');
  });

  it('TOTAL: a throwing accessor yields a verdict, not an exception', () => {
    const hostile = new Proxy({ epoch: 1, root: R(1) }, {
      get() { throw new Error('hostile'); },
    }) as { epoch: number; root: string };
    const v = checkEpochFreshness(hostile, stream(1, 3), { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(['freshness-check-threw']);
  });

  it('MISSING POLICY IS THE STRICT ONE: an absent maxEpochLag behaves as 0, never as unbounded', () => {
    const v = checkEpochFreshness({ epoch: 7, root: R(7) }, stream(1, 10), {} as unknown as { maxEpochLag: number });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
  });

  it('INVARIANT: ok implies the reason list is empty, across every shape above', () => {
    const shapes: Array<[{ epoch: number; root: string }, AnchorObservation[], number]> = [
      [{ epoch: 10, root: R(10) }, stream(1, 10), 0],
      [{ epoch: 7, root: R(7) }, stream(1, 10), 3],
      [{ epoch: 7, root: R(7) }, stream(1, 10), 0],
      [{ epoch: -1, root: R(1) }, stream(1, 10), 0],
      [{ epoch: 4, root: R(4) }, [obs(4, R(44))], 0],
      [{ epoch: 3, root: R(3) }, [], 0],
    ];
    for (const [pres, feed, maxEpochLag] of shapes) {
      const v = checkEpochFreshness(pres, feed, { maxEpochLag });
      if (v.ok) expect(v.reasons).toEqual([]);
    }
  });
});

describe('derivedMaxEpochLag — the bound the measurement says to use', () => {
  it('is the ceiling of latency over period', () => {
    expect(derivedMaxEpochLag(40, 50)).toBe(1);
    expect(derivedMaxEpochLag(120, 50)).toBe(3);
    expect(derivedMaxEpochLag(200, 50)).toBe(4);
    expect(derivedMaxEpochLag(100, 50)).toBe(2);
  });

  it.each([[0, 50], [-1, 50], [40, 0], [40, -5], [NaN, 50], [40, Infinity]])(
    'returns the STRICT bound 0 for a degenerate (%p, %p), never an open one',
    (latency, period) => {
      expect(derivedMaxEpochLag(latency as number, period as number)).toBe(0);
    },
  );
});
