/**
 * The freshness check (#260) compares epochs across committers, and `epoch` is a per-agent counter.
 *
 * These tests recompute the report's claims rather than quoting them (Beat 57's lesson: a published
 * figure that nothing recomputes is a figure nobody checked), and they pin the property in BOTH
 * directions — the precondition under which the module is correct, and the cost of not meeting it.
 *
 * WHEN `AnchorObservation` GAINS A COMMITTER FIELD and the comparisons are scoped to it, the
 * "unfiltered" expectations below are the ones that must change, and they should change to match the
 * "filtered" ones. That is the whole finding, written as an executable statement of it.
 */

import { checkEpochFreshness } from '../src/memory/epoch-freshness';
import type { AnchorObservation } from '../src/memory/epoch-freshness';
import type { Hex } from '../src/memory/leanimt-plus';
import { runMultiCommitter, sweep } from '../scripts/sim/multi-committer-freshness';

const R = (s: string): Hex => `0x${s.padEnd(64, '0')}` as Hex;
const obs = (epoch: number, root: Hex, source: string): AnchorObservation => ({ epoch, root, source });

describe('freshness across committers — the stream is assumed to be one agent\'s, and nothing says so', () => {
  it('PRECONDITION HOLDS: against its own agent\'s anchors, an honest current publication is fresh', () => {
    const v = checkEpochFreshness({ epoch: 5, root: R('a5') }, [
      obs(4, R('a4'), 'chain:alpha'),
      obs(5, R('a5'), 'chain:alpha'),
    ], { maxEpochLag: 0 });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('TWO HONEST AGENTS EQUIVOCATE: each at its own epoch 5, neither withholding anything', () => {
    const v = checkEpochFreshness({ epoch: 5, root: R('a5') }, [
      obs(5, R('a5'), 'chain:alpha'),
      obs(5, R('b5'), 'chain:beta'),
    ], { maxEpochLag: 3 });
    // `epoch-equivocation` is the module's strongest accusation — documented as evidence an honest
    // committer cannot produce ("a lagging publication is explicable by latency, an equivocating
    // committer is not"). Here two honest committers produce it by existing.
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('epoch-equivocation');
    expect(v.equivocation).not.toBeNull();
  });

  it('A FASTER PEER MAKES A CURRENT AGENT STALE: alpha is at its own newest epoch and is refused', () => {
    const v = checkEpochFreshness({ epoch: 3, root: R('a3') }, [
      obs(3, R('a3'), 'chain:alpha'),
      obs(40, R('b40'), 'chain:beta'),
    ], { maxEpochLag: 3 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
    expect(v.epochLag).toBe(37);
  });

  it('THE LAG BOUND IS INOPERATIVE HERE: equivocation is unconditional, so no policy rescues it', () => {
    const stream = [obs(5, R('a5'), 'chain:alpha'), obs(5, R('b5'), 'chain:beta')];
    for (const maxEpochLag of [0, 1, 3, 1000]) {
      expect(checkEpochFreshness({ epoch: 5, root: R('a5') }, stream, { maxEpochLag }).ok).toBe(false);
    }
  });

  it('MEASURED: an unfiltered stream refuses every honest publication; a filtered one refuses none', () => {
    for (const row of sweep()) {
      expect(row.unfilteredRefusalPct).toBe(100);
      expect(row.filteredRefusalPct).toBe(0);
      expect(row.reasonPct['epoch-equivocation']).toBe(100);
    }
  });

  it('MEASURED: two committers are already enough — this is not a scale effect', () => {
    const two = runMultiCommitter(1, 2, 200, 3);
    expect(two.unfilteredRefusalPct).toBe(100);
    expect(two.filteredRefusalPct).toBe(0);
  });

  it('DIRECTION OF FAILURE: the cost is refusal, never acceptance — fail-closed is not broken', () => {
    // A withheld epoch must still be refused when the stream is correctly scoped, i.e. the finding
    // is a false-abstention result and does NOT weaken the check it is about.
    const v = checkEpochFreshness({ epoch: 7, root: R('a7') }, [
      obs(7, R('a7'), 'chain:alpha'),
      obs(8, R('a8'), 'chain:alpha'),
    ], { maxEpochLag: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('stale-epoch');
  });
});
