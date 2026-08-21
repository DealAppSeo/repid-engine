/**
 * risk-tier.test.ts
 *
 * The load-bearing assertion in this file is not a band boundary. It is
 * `familiarity can never buy a lower band`: if it could, a colluding pair would
 * manufacture cheap interactions to discount the one transfer that mattered, and
 * the wash-trading cost asymmetry `x402-outcome-link.ts` establishes would be
 * undone by the risk layer sitting above it.
 */
import {
  RiskBand,
  assessRisk,
  noveltyMultiplier,
  requiresBatchedAnchor,
  requiresIndividualAttestation,
  DEFAULT_T1_USDC,
  DEFAULT_T2_USDC,
  NOVELTY_MAX_UPLIFT,
} from '../src/services/risk-tier';

describe('novelty uplift', () => {
  it('is bounded below by exactly 1 — familiarity never discounts risk', () => {
    for (const priors of [0, 1, 2, 5, 20, 100, 10_000, 1e9]) {
      expect(noveltyMultiplier(priors)).toBeGreaterThan(1);
    }
    // Asymptotic to 1 from above, never reaching or crossing it.
    expect(noveltyMultiplier(1e9)).toBeCloseTo(1, 6);
  });

  it('is maximal at zero priors and monotonically decreasing', () => {
    expect(noveltyMultiplier(0)).toBeCloseTo(1 + NOVELTY_MAX_UPLIFT, 10);
    let prev = Infinity;
    for (const priors of [0, 1, 2, 3, 10, 50, 500]) {
      const m = noveltyMultiplier(priors);
      expect(m).toBeLessThan(prev);
      prev = m;
    }
  });

  it('treats an unknown count and a corrupt count as maximum novelty, not minimum', () => {
    // Conservative direction: no history known means MORE scrutiny, not less.
    expect(noveltyMultiplier(null)).toBe(noveltyMultiplier(0));
    expect(noveltyMultiplier(-5)).toBe(noveltyMultiplier(0));
  });
});

describe('value at risk', () => {
  it('is a max, not a sum — stake backs the service, it is not a second exposure', () => {
    const a = assessRisk({ serviceValueUsdc: 50, stakeExposedUsdc: 500, priorInteractions: 50 });
    expect(a.valueAtRisk).toBe(500);
    const b = assessRisk({ serviceValueUsdc: 500, stakeExposedUsdc: 50, priorInteractions: 50 });
    expect(b.valueAtRisk).toBe(500);
  });

  it('treats negative and non-finite money as zero rather than throwing on the scoring path', () => {
    const a = assessRisk({ serviceValueUsdc: -100, stakeExposedUsdc: NaN, priorInteractions: 0 });
    expect(a.valueAtRisk).toBe(0);
    expect(a.band).toBe(RiskBand.OFF_CHAIN);
  });
});

describe('bands', () => {
  const familiar = { priorInteractions: 10_000_000 }; // uplift ~1, so raw value nearly drives the band

  /**
   * Boundaries are asserted on EFFECTIVE value at risk, because that is what the
   * band is defined over. At zero priors the multiplier is exactly 1.5, and 1.5
   * times these integers is exact in binary floating point — so these hit the
   * edges dead on rather than near them.
   */
  it('is inclusive at both edges of the batched band', () => {
    const at = (serviceValueUsdc: number) =>
      assessRisk({
        serviceValueUsdc,
        stakeExposedUsdc: 0,
        priorInteractions: 0,
        thresholds: { t1: 150, t2: 300 },
      });

    expect(at(99).effectiveValueAtRisk).toBe(148.5);
    expect(at(99).band).toBe(RiskBand.OFF_CHAIN);
    expect(at(100).effectiveValueAtRisk).toBe(150); // exactly T1
    expect(at(100).band).toBe(RiskBand.BATCHED);
    expect(at(200).effectiveValueAtRisk).toBe(300); // exactly T2
    expect(at(200).band).toBe(RiskBand.BATCHED);
    expect(at(201).band).toBe(RiskBand.ATTESTED);
  });

  it('places small value off chain and large value attested against the default anchors', () => {
    expect(assessRisk({ serviceValueUsdc: 1, stakeExposedUsdc: 0, ...familiar }).band).toBe(RiskBand.OFF_CHAIN);
    expect(assessRisk({ serviceValueUsdc: DEFAULT_T1_USDC, stakeExposedUsdc: 0, ...familiar }).band).toBe(
      RiskBand.BATCHED,
    );
    expect(assessRisk({ serviceValueUsdc: DEFAULT_T2_USDC * 2, stakeExposedUsdc: 0, ...familiar }).band).toBe(
      RiskBand.ATTESTED,
    );
  });

  /**
   * A consequence worth pinning rather than discovering later: because the
   * novelty multiplier is strictly greater than 1, a FACE value of exactly T2
   * always lands in ATTESTED, however familiar the pair. The batched band is
   * `[T1, T2]` in effective value and therefore `[T1/m, T2/m)` in face value.
   *
   * That is the conservative direction — the edge case gets MORE scrutiny, not
   * less — but anyone setting T2 to a round number should know they are setting
   * it slightly below where face value crosses.
   */
  it('sends a face value of exactly T2 to ATTESTED, because novelty is never zero', () => {
    const a = assessRisk({ serviceValueUsdc: DEFAULT_T2_USDC, stakeExposedUsdc: 0, ...familiar });
    expect(a.effectiveValueAtRisk).toBeGreaterThan(DEFAULT_T2_USDC);
    expect(a.band).toBe(RiskBand.ATTESTED);
  });

  it('refuses inverted thresholds loudly instead of silently emptying the middle band', () => {
    expect(() =>
      assessRisk({
        serviceValueUsdc: 10,
        stakeExposedUsdc: 0,
        priorInteractions: 0,
        thresholds: { t1: 1000, t2: 100 },
      }),
    ).toThrow(/inverted/i);
  });

  it('exposes the band as two predicates that never both hold', () => {
    for (const value of [1, 100, 1000, 5000]) {
      const a = assessRisk({ serviceValueUsdc: value, stakeExposedUsdc: 0, ...familiar });
      expect(requiresBatchedAnchor(a.band) && requiresIndividualAttestation(a.band)).toBe(false);
    }
  });
});

describe('the anti-collusion property', () => {
  /**
   * A colluding pair's whole play is to make themselves look familiar to each
   * other before the transfer they care about. This asserts the payoff is zero:
   * across the entire history range, farming familiarity can only ever move an
   * interaction back to the band its RAW value already earned.
   */
  it('farming prior interactions never yields a band below the raw-value band', () => {
    for (const value of [1, 50, 99, 100, 101, 500, 999, 1000, 1001, 5000]) {
      const rawBand = assessRisk({
        serviceValueUsdc: value,
        stakeExposedUsdc: 0,
        priorInteractions: Number.MAX_SAFE_INTEGER,
      }).band;

      for (const priors of [0, 1, 5, 50, 5000]) {
        const farmed = assessRisk({ serviceValueUsdc: value, stakeExposedUsdc: 0, priorInteractions: priors });
        const order = { [RiskBand.OFF_CHAIN]: 0, [RiskBand.BATCHED]: 1, [RiskBand.ATTESTED]: 2 };
        expect(order[farmed.band]).toBeGreaterThanOrEqual(order[rawBand]);
      }
    }
  });
});

describe('evidence honesty', () => {
  it('reports an unlooked-up interaction count as NOT_CHECKED, never as a measured zero', () => {
    const unknown = assessRisk({ serviceValueUsdc: 10, stakeExposedUsdc: 0, priorInteractions: null });
    const measuredZero = assessRisk({ serviceValueUsdc: 10, stakeExposedUsdc: 0, priorInteractions: 0 });

    // Same arithmetic — the conservative choice.
    expect(unknown.effectiveValueAtRisk).toBe(measuredZero.effectiveValueAtRisk);
    // Different claim about what is known. This is the whole point.
    expect(unknown.noveltyEvidence).toBe('NOT_CHECKED');
    expect(measuredZero.noveltyEvidence).toBe('MEASURED');
  });

  it('carries enough basis to recompute the band from the stored assessment alone', () => {
    const a = assessRisk({ serviceValueUsdc: 300, stakeExposedUsdc: 900, priorInteractions: 3 });
    expect(a.basis).toMatchObject({ serviceValueUsdc: 300, stakeExposedUsdc: 900, priorInteractions: 3 });
    expect(a.effectiveValueAtRisk).toBeCloseTo(900 * noveltyMultiplier(3), 6);
  });
});
