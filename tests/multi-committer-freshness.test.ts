/**
 * The freshness check (#260) compared epochs across committers, and `epoch` is a per-agent counter.
 *
 * #262 measured the cost of that: 100% of honest, maximally-fresh publications refused, ~all with
 * `epoch-equivocation`. Its header ended with an instruction —
 *
 *     "WHEN `AnchorObservation` GAINS A COMMITTER FIELD and the comparisons are scoped to it, the
 *      'unfiltered' expectations below are the ones that must change, and they should change to
 *      match the 'filtered' ones."
 *
 * Beat 60 made that change, and this file is the flip. It is deliberately kept as the SAME fixtures
 * with inverted verdicts rather than rewritten from scratch, so the diff is the proof: every case
 * that used to refuse an honest agent now accepts it, and every case that used to catch a real
 * withholder still catches it. The tests continue to recompute the simulation's figures rather than
 * quoting them (Beat 57: a published figure that nothing recomputes is a figure nobody checked).
 */

import { checkEpochFreshness } from '../src/memory/epoch-freshness';
import type { AnchorObservation } from '../src/memory/epoch-freshness';
import type { Hex } from '../src/memory/leanimt-plus';
import { runMultiCommitter, sweep, coverageSweep } from '../scripts/sim/multi-committer-freshness';

const R = (s: string): Hex => `0x${s.padEnd(64, '0')}` as Hex;
const obs = (epoch: number, root: Hex, source: string, committer = 'alpha'): AnchorObservation =>
  ({ epoch, root, committer, source });
const A = 'alpha';

describe('freshness across committers — the precondition, now written down and enforced', () => {
  it('PRECONDITION HOLDS: against its own agent\'s anchors, an honest current publication is fresh', () => {
    const v = checkEpochFreshness({ epoch: 5, root: R('a5'), committer: A }, [
      obs(4, R('a4'), 'chain:alpha'),
      obs(5, R('a5'), 'chain:alpha'),
    ], { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('FLIPPED — TWO HONEST AGENTS NO LONGER EQUIVOCATE: each at its own epoch 5, neither withholding', () => {
    const v = checkEpochFreshness({ epoch: 5, root: R('a5'), committer: A }, [
      obs(5, R('a5'), 'chain:alpha'),
      obs(5, R('b5'), 'chain:beta', 'beta'),
    ], { maxEpochLag: 3 });
    // Before scoping this returned `epoch-equivocation` — the module's strongest accusation,
    // documented as evidence an honest committer cannot produce, and produced here by two honest
    // committers simply existing. Beta's epoch 5 is now out of scope, and says so in its own field.
    expect(v.ok).toBe(true);
    expect(v.equivocation).toBeNull();
    expect(v.otherCommitterObservations).toBe(1);
  });

  it('FLIPPED — A FASTER PEER NO LONGER MAKES A CURRENT AGENT STALE', () => {
    const v = checkEpochFreshness({ epoch: 3, root: R('a3'), committer: A }, [
      obs(3, R('a3'), 'chain:alpha'),
      obs(40, R('b40'), 'chain:beta', 'beta'),
    ], { maxEpochLag: 3 });
    expect(v.ok).toBe(true);
    expect(v.latestKnownEpoch).toBe(3);   // was 40 — another agent's counter setting alpha's bar
    expect(v.epochLag).toBe(0);           // was 37
  });

  it('FLIPPED — THE LAG BOUND IS OPERATIVE AGAIN: it decides, instead of being pre-empted', () => {
    // The bound is the entire subject of #260's measurement. Unscoped, equivocation refused first
    // and the dial changed nothing at 0, 1, 3 or 1000. Scoped, the dial is what decides.
    const stream = [
      obs(5, R('a5'), 'chain:alpha'),
      obs(9, R('a9'), 'chain:alpha'),
      obs(5, R('b5'), 'chain:beta', 'beta'),
    ];
    const at = (maxEpochLag: number) =>
      checkEpochFreshness({ epoch: 5, root: R('a5'), committer: A }, stream, { maxEpochLag });
    expect(at(0).ok).toBe(false);
    expect(at(3).ok).toBe(false);
    expect(at(4).ok).toBe(true);    // lag is exactly 9 - 5
    expect(at(1000).ok).toBe(true);
  });

  it('MEASURED — FLIPPED: the multi-committer stream now refuses none of them, and by the same route', () => {
    for (const row of sweep()) {
      expect(row.unfilteredRefusalPct).toBe(0);
      expect(row.filteredRefusalPct).toBe(0);
      // Caller-side filtering is now redundant, which is the point: the two columns must agree.
      expect(row.unfilteredRefusalPct).toBe(row.filteredRefusalPct);
      expect(row.reasonPct['epoch-equivocation']).toBeUndefined();
    }
  });

  it('MEASURED — FLIPPED: two committers were enough to break it, and are enough to show it fixed', () => {
    const two = runMultiCommitter(1, 2, 200, 3);
    expect(two.unfilteredRefusalPct).toBe(0);
    expect(two.filteredRefusalPct).toBe(0);
  });

  it('MEASURED — WHAT THE FIX COSTS: refusal rises with UNcovered committers, and only as no-evidence', () => {
    // #262's filtered column was 0.0% everywhere and invites "the precondition is free". It was
    // measured with every agent present in the stream. Below full coverage the scoped check refuses
    // for want of evidence — a strictly better failure than a false accusation, but not nothing.
    const rows = coverageSweep();
    const byCoverage = new Map<number, number[]>();
    for (const r of rows) byCoverage.set(r.coverage, [...(byCoverage.get(r.coverage) ?? []), r.unfilteredRefusalPct]);

    for (const pct of byCoverage.get(1) ?? []) expect(pct).toBe(0);
    const worst = (cov: number): number => Math.max(...(byCoverage.get(cov) ?? [0]));
    // Monotone in the direction the mechanism predicts: less coverage, more no-evidence refusals.
    expect(worst(0.75)).toBeGreaterThan(0);
    expect(worst(0.5)).toBeGreaterThan(worst(0.75));
    expect(worst(0.25)).toBeGreaterThan(worst(0.5));
    // ...and it is entirely the honest boundary, never an accusation.
    for (const r of rows) {
      expect(r.reasonPct['epoch-equivocation']).toBeUndefined();
      expect(r.reasonPct['stale-epoch']).toBeUndefined();
    }
  });

  it('UNCHANGED — DIRECTION OF FAILURE: a withheld epoch is still refused, scoping does not weaken it', () => {
    const v = checkEpochFreshness({ epoch: 7, root: R('a7'), committer: A }, [
      obs(7, R('a7'), 'chain:alpha'),
      obs(8, R('a8'), 'chain:alpha'),
    ], { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
  });
});
