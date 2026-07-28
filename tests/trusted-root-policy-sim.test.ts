/**
 * Pins the claims made in reports/2026-07-28/BEAT57_TRUSTED_ROOT_POLICY.md.
 *
 * Beat 54 refuted repid-engine #251 because the artifact could not recompute its own
 * published figures. These assertions exist so that failure mode cannot recur here: the
 * numbers in the report are the numbers this suite recomputes, or the suite goes red.
 *
 * Only claims the report actually MAKES are asserted. The unsound-accept decimals are
 * deliberately NOT pinned to a value — the report declines to quote them (too few events),
 * so pinning them would assert more than the report claims.
 */
import { simulate, DEFAULTS, type SimParams } from '../scripts/sim/trusted-root-policy';

const P = (o: Partial<SimParams> = {}): SimParams => ({ ...DEFAULTS, ops: 20000, ...o });
const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

describe('trusted-root policy simulation — the report recomputes its own claims', () => {
  const seeds = [1, 2, 3];

  it('is deterministic: the same seed yields identical scores', () => {
    const a = simulate(P({ seed: 1 }));
    const b = simulate(P({ seed: 1 }));
    expect(b).toEqual(a);
  });

  it('LIVE_ROOT false-abstains on essentially every answer (report: >99%, all seeds)', () => {
    for (const seed of seeds) {
      const { scores } = simulate(P({ seed }));
      const s = scores.LIVE_ROOT;
      const denom = s.correct + s.falseAbstain + s.unsoundAccept;
      expect(denom).toBeGreaterThan(1000);            // the sample is real, not a handful
      expect(rate(s.falseAbstain, denom)).toBeGreaterThan(0.99);
      expect(s.unsoundAccept).toBe(0);                // it is over-strict, never unsound
    }
  });

  it('ANCHORED_EPOCH_EMIT never false-abstains — roots match by construction', () => {
    for (const seed of seeds) {
      const { scores } = simulate(P({ seed }));
      expect(scores.ANCHORED_EPOCH_EMIT.falseAbstain).toBe(0);
    }
  });

  it('the naive pairing (anchored root, live emit) is no better than LIVE_ROOT', () => {
    for (const seed of seeds) {
      const { scores } = simulate(P({ seed }));
      const s = scores.ANCHORED_LIVE_EMIT;
      const denom = s.correct + s.falseAbstain + s.unsoundAccept;
      expect(rate(s.falseAbstain, denom)).toBeGreaterThan(0.95);
    }
  });

  it('RE_DERIVE is the oracle — 0 on both error columns, by construction not by merit', () => {
    for (const seed of seeds) {
      const { scores } = simulate(P({ seed }));
      expect(scores.RE_DERIVE.falseAbstain).toBe(0);
      expect(scores.RE_DERIVE.unsoundAccept).toBe(0);
    }
  });

  /**
   * THE LOAD-BEARING CLAIM of the report: unciteable and unsound-accept are two faces of one
   * quantity (snapshot age), so they CO-MOVE with cadence rather than trading off. If a future
   * change made them trade off, the report's recommendation ("shorten the epoch; the only
   * counterweight is anchor cost") would be wrong and this test must catch it.
   */
  it('unciteable rises monotonically with epoch length; unsound-accept rises only endpoint-to-endpoint', () => {
    const cadences = [10, 25, 50, 100, 250];
    for (const seed of seeds) {
      const rows = cadences.map((epochEvery) => {
        const { scores, emitted } = simulate(P({ seed, epochEvery }));
        const s = scores.ANCHORED_EPOCH_EMIT;
        const denom = s.correct + s.falseAbstain + s.unsoundAccept;
        return { epochEvery, unciteable: rate(s.unciteable, emitted), unsound: rate(s.unsoundAccept, denom) };
      });
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.unciteable).toBeGreaterThan(rows[i - 1]!.unciteable);
      }
      // NOT asserted step-wise: unsound-accept rests on ~10-20 events per run and adjacent
      // cadences genuinely invert (measured 0.14% -> 0.12% at seed 1, which is what sent the
      // first version of this assertion red). Endpoint-to-endpoint is the strongest true
      // statement, and it is what the report claims.
      expect(rows[4]!.unsound).toBeGreaterThan(rows[0]!.unsound);
      expect(rows[0]!.unciteable).toBeLessThan(0.01);   // ~0.1-0.3% at epochEvery=10
      expect(rows[4]!.unciteable).toBeGreaterThan(0.03); // ~4.2-4.6% at epochEvery=250
    }
  });

  it('the workload actually produces retractions-before-verification, or the scoring is vacuous', () => {
    for (const seed of seeds) {
      const { retractedAtVerify, emitted } = simulate(P({ seed }));
      expect(emitted).toBeGreaterThan(1000);
      expect(retractedAtVerify).toBeGreaterThan(0);
    }
  });
});
