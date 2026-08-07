/**
 * STEP 3 evidence — HAL confidence calibration.
 *
 * The load-bearing test is RANKING PRESERVATION. Calibration must not be able to
 * become a retune wearing calibration's name: if the transform could reorder two
 * cases, it would change verdicts, and every accuracy number ever quoted against
 * this corpus would have been measured on a ruler that was itself being bent.
 * That property is checked against the REAL holdout artifact, not a synthetic
 * stand-in.
 *
 * The second is DIRECTION. `verdictConfidence` is trivially easy to get
 * backwards, and backwards is silent: it would reward hallucinations and punish
 * clean answers while every type still checked and every number stayed inside
 * [0,1].
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  fitCalibrator,
  fitTemperature,
  applyCalibrator,
  applyTemperature,
  expectedCalibrationError,
  crossValidatedEce,
  verdictConfidence,
  calibrate,
  assertRuler,
  toLogit,
  sigmoid,
  type CalibrationSample,
  type FittedCalibrator,
} from '../src/services/hal-calibration';

const HOLDOUT = join(__dirname, '../reports/hal-eval/rigorous-v1-holdout-596f10de18d0.LOCAL.json');

/** A deterministic two-class set. No RNG — a reviewer rerunning gets our numbers. */
function synthetic(temperature: number, n = 60): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < n; i++) {
    const z = -6 + (12 * i) / (n - 1); // true logit
    const pTrue = sigmoid(z);
    // Deform by a known temperature: this is the raw score the "model" emits.
    const raw = sigmoid(z * temperature);
    // Deterministic labelling at the true rate: 10 copies, of which round(10*p)
    // are positive. Recovers the population without sampling noise.
    const pos = Math.round(10 * pTrue);
    for (let k = 0; k < 10; k++) out.push({ rawScore: raw, isPositive: k < pos });
  }
  return out;
}

describe('the optimiser actually recovers a known distortion', () => {
  it('recovers a temperature it was given', () => {
    // If this drifts, every number downstream is a fit to nothing. The raw score
    // was built as sigmoid(z * 0.5), so the corrective scale should be ~2.
    const cal = fitCalibrator(synthetic(0.5), { ruler: 't', corpusSha256: 't', method: 'temperature' });
    expect(cal.scale).toBeGreaterThan(1.6);
    expect(cal.scale).toBeLessThan(2.5);
  });

  it('leaves an already-calibrated score alone', () => {
    const cal = fitCalibrator(synthetic(1.0), { ruler: 't', corpusSha256: 't', method: 'temperature' });
    expect(cal.temperature).toBeGreaterThan(0.8);
    expect(cal.temperature).toBeLessThan(1.25);
  });

  it('platt reaches at least as low an NLL as temperature — it is a superset', () => {
    // Coordinate descent that ended above the temperature-only optimum would
    // mean it converged to a saddle rather than the joint optimum.
    const s = synthetic(0.5);
    const t = fitCalibrator(s, { ruler: 't', corpusSha256: 't', method: 'temperature' });
    const p = fitCalibrator(s, { ruler: 't', corpusSha256: 't', method: 'platt' });
    expect(p.nll).toBeLessThanOrEqual(t.nll + 1e-6);
  });
});

describe('ECE measures what it claims to', () => {
  it('is near zero for a perfectly calibrated set', () => {
    const s = synthetic(1.0);
    const e = expectedCalibrationError(s.map((x) => ({ p: x.rawScore, isPositive: x.isPositive })));
    expect(e.ece).toBeLessThan(0.05);
  });

  it('is large for a badly miscalibrated set', () => {
    const s = synthetic(0.2); // heavily under-confident
    const e = expectedCalibrationError(s.map((x) => ({ p: x.rawScore, isPositive: x.isPositive })));
    expect(e.ece).toBeGreaterThan(0.1);
  });

  it('reports maxGap alongside ECE, because an average hides a bad bin', () => {
    const e = expectedCalibrationError([
      // 99 well-calibrated points and one bin that is completely wrong.
      //
      // The predicted value here has to be ~0, not merely "low": at p = 0.05
      // with an observed rate of 0, those 99 points carry a 0.05 gap of their
      // own and swamp the effect being demonstrated. The first version of this
      // fixture made exactly that mistake and failed — a miscalibrated test for
      // miscalibration.
      ...Array.from({ length: 99 }, () => ({ p: 0.001, isPositive: false })),
      { p: 0.95, isPositive: false },
    ]);
    expect(e.ece).toBeLessThan(0.02); // the average barely notices
    expect(e.maxGap).toBeGreaterThan(0.9); // maxGap does
  });
});

describe('calibration NEVER reorders — otherwise it is a retune', () => {
  const cal: FittedCalibrator = {
    method: 'platt',
    scale: 1.2207,
    bias: 0.4079,
    temperature: 0.8192,
    ruler: 'test',
    corpusSha256: 'test',
    fittedOn: 99,
    nll: 0.227,
  };

  it('is strictly monotone in the raw score', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const p = applyCalibrator(i / 100, cal);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('preserves the holdout confusion matrix under the SCALE component', () => {
    if (!existsSync(HOLDOUT)) {
      throw new Error(
        `holdout artifact missing at ${HOLDOUT} — refusing to pass a calibration test with no ruler behind it`,
      );
    }
    const doc = JSON.parse(readFileSync(HOLDOUT, 'utf8'));
    const conf = (score: (r: any) => number) => {
      let tp = 0, fp = 0, tn = 0, fn = 0;
      for (const r of doc.results) {
        const pred = score(r) >= 0.5;
        const act = r.truth === 'FALSE';
        if (pred && act) tp++;
        else if (pred && !act) fp++;
        else if (!pred && !act) tn++;
        else fn++;
      }
      return { tp, fp, tn, fn };
    };
    const before = conf((r) => r.halScore);
    const after = conf((r) => applyCalibrator(r.halScore, { scale: cal.scale, bias: 0 }));
    expect(after).toEqual(before);
    // And the measured baseline is what the frozen artifact says it is.
    expect(before).toEqual({ tp: 44, fp: 4, tn: 47, fn: 4 });
  });
});

describe('direction — backwards here would be silent and catastrophic', () => {
  const cal: FittedCalibrator = {
    method: 'platt', scale: 1.2207, bias: 0.4079, temperature: 0.8192,
    ruler: 'test', corpusSha256: 'test', fittedOn: 99, nll: 0.227,
  };

  it('a CONFIDENT VETO yields HIGH confidence — so the penalty is amplified', () => {
    const c = calibrate(0.99, 'vetoed', cal);
    expect(c.confidence).toBeGreaterThan(0.95);
  });

  it('a CONFIDENT CLEAN yields HIGH confidence — so the reward is full', () => {
    const c = calibrate(0.01, 'clean', cal);
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it('an UNCERTAIN verdict yields LOW confidence either way — reputation barely moves', () => {
    // The payoff of defining confidence per-verdict rather than per-score: when
    // HAL is torn, BOTH the reward and the penalty shrink toward nothing.
    const p = applyCalibrator(0.5, cal);
    const asVeto = verdictConfidence(p, 'vetoed');
    const asClean = verdictConfidence(p, 'clean');
    expect(Math.max(asVeto, asClean)).toBeLessThan(0.75);
    expect(asVeto + asClean).toBeCloseTo(1, 10);
  });

  it('keeps the raw score for audit and never silently discards it', () => {
    const c = calibrate(0.515, 'vetoed', cal);
    expect(c.raw).toBe(0.515);
    expect(c.calibratedPFalse).not.toBe(0.515);
    expect(c.ruler).toBe('test');
  });
});

describe('refuses rather than fabricating', () => {
  it('refuses to fit on a single-class corpus', () => {
    // The optimum is unbounded; anything returned would be the search bound in
    // disguise.
    const allTrue: CalibrationSample[] = [
      { rawScore: 0.1, isPositive: true },
      { rawScore: 0.9, isPositive: true },
    ];
    expect(() => fitCalibrator(allTrue, { ruler: 'x', corpusSha256: 'x' })).toThrow(/single-class/);
  });

  it('refuses to fit on nothing', () => {
    expect(() => fitCalibrator([], { ruler: 'x', corpusSha256: 'x' })).toThrow(/zero usable/);
  });

  it('refuses a calibrator fitted on a DIFFERENT corpus', () => {
    const cal = fitTemperature(synthetic(0.5), { ruler: 'a', corpusSha256: 'aaaaaaaaaaaa' });
    expect(() => assertRuler(cal, 'bbbbbbbbbbbb')).toThrow(/ruler mismatch/);
    expect(() => assertRuler(cal, 'aaaaaaaaaaaa')).not.toThrow();
  });
});

describe('malformed input yields uncertainty, never NaN', () => {
  it('NaN raw score becomes 0.5, not NaN', () => {
    // A NaN confidence multiplied into a delta yields a NaN delta, which the
    // fold encoder then rejects far away from the cause. Stop it here.
    expect(applyTemperature(NaN, 0.8)).toBe(0.5);
    expect(applyCalibrator(NaN, { scale: 1.2, bias: 0.4 })).toBe(0.5);
    expect(verdictConfidence(NaN, 'vetoed')).toBe(0.5);
  });

  it('a non-positive or non-finite temperature yields 0.5 rather than a wrong number', () => {
    expect(applyTemperature(0.9, 0)).toBe(0.5);
    expect(applyTemperature(0.9, -1)).toBe(0.5);
    expect(applyTemperature(0.9, NaN)).toBe(0.5);
  });

  it('clips saturated scores instead of producing infinite logits', () => {
    expect(Number.isFinite(toLogit(0))).toBe(true);
    expect(Number.isFinite(toLogit(1))).toBe(true);
    expect(Number.isFinite(applyCalibrator(1, { scale: 40, bias: 0 }))).toBe(true);
  });

  it('sigmoid does not overflow at extreme inputs', () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
  });
});

describe('cross-validation is deterministic and honest', () => {
  it('gives the same answer twice', () => {
    // Fold assignment is index % k, not a shuffle. A reviewer rerunning this
    // gets our number, not a nearby one.
    const s = synthetic(0.5, 50);
    const a = crossValidatedEce(s, 5);
    const b = crossValidatedEce(s, 5);
    expect(a.ece.ece).toBe(b.ece.ece);
    expect(a.temperatures).toEqual(b.temperatures);
  });

  it('out-of-fold ECE is not better than in-sample — the whole point of measuring it', () => {
    const s = synthetic(0.4, 60);
    const cal = fitCalibrator(s, { ruler: 't', corpusSha256: 't' });
    const inSample = expectedCalibrationError(
      s.map((x) => ({ p: applyCalibrator(x.rawScore, cal), isPositive: x.isPositive })),
    );
    const oof = crossValidatedEce(s, 5);
    expect(oof.ece.ece).toBeGreaterThanOrEqual(inSample.ece - 1e-9);
  });
});
