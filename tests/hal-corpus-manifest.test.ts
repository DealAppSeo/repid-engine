/**
 * Corpus manifest + ruler refusal.
 *
 * These tests encode the property that was missing when HAL's F1 was quoted at 0.34, 0.74, 0.886 and
 * 0.890: an accuracy number must be inseparable from the corpus and configuration it was taken with.
 * Pure — no DB, no network, no provider keys.
 */
import {
  buildCorpusManifest,
  computeCorpusHash,
  corpusComparabilityFault,
  CorpusCase,
  describeCorpus,
  InvalidCorpusError,
  isSameCorpus,
  shortHash,
  sortCasesById,
} from '../src/hal/corpus-manifest';
import {
  assertComparable,
  assertRuler,
  ConfigurationWidth,
  describeWidth,
  formatMeasurement,
  formatUnattributed,
  IncomparableMeasurementError,
  MeasurementRuler,
  metricsFromMatrix,
  MissingRulerError,
  recordMeasurement,
  rulerFaults,
  UNATTRIBUTED,
} from '../src/hal/measurement-ruler';

const AT = new Date('2026-08-03T00:00:00.000Z');

function cases(n: number, prefix = 'c'): CorpusCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    text: `statement ${i}`,
    expectedHallucination: i % 2 === 0,
  }));
}

function width(over: Partial<ConfigurationWidth> = {}): ConfigurationWidth {
  return {
    familiesConfigured: 2,
    familiesMin: 2,
    familiesMax: 2,
    strictness: 2,
    decisionRequiresQuorum: true,
    penaltyRequiresQuorum: true,
    ...over,
  };
}

function ruler(over: { cases?: CorpusCase[]; corpusId?: string; width?: Partial<ConfigurationWidth> } = {}): MeasurementRuler {
  return {
    corpus: buildCorpusManifest({
      corpusId: over.corpusId ?? 'hal-test-v1',
      cases: over.cases ?? cases(10),
      builtAt: AT,
    }),
    width: width(over.width),
  };
}

describe('corpus hash is a receipt, not a promise', () => {
  it('is deterministic for the same ordered case set', () => {
    expect(computeCorpusHash(cases(20))).toBe(computeCorpusHash(cases(20)));
  });

  it('changes when a single case label flips', () => {
    const a = cases(5);
    const b = cases(5);
    b[2] = { ...b[2]!, expectedHallucination: !b[2]!.expectedHallucination };
    expect(computeCorpusHash(a)).not.toBe(computeCorpusHash(b));
  });

  it('changes when a single case text changes', () => {
    const a = cases(5);
    const b = cases(5);
    b[4] = { ...b[4]!, text: 'different' };
    expect(computeCorpusHash(a)).not.toBe(computeCorpusHash(b));
  });

  it('changes when cases are reordered — order is part of the ruler', () => {
    const a = cases(6);
    const b = [...a.slice(3), ...a.slice(0, 3)];
    expect(computeCorpusHash(a)).not.toBe(computeCorpusHash(b));
  });

  it('sortCasesById gives order-independent callers a canonical order', () => {
    const a = cases(6);
    const shuffled = [a[3]!, a[0]!, a[5]!, a[1]!, a[4]!, a[2]!];
    expect(computeCorpusHash(sortCasesById(a))).toBe(computeCorpusHash(sortCasesById(shuffled)));
  });

  it('cannot be tricked by moving characters between adjacent fields', () => {
    const a: CorpusCase[] = [{ id: 'x', text: 'ab', expectedHallucination: false, context: 'c' }];
    const b: CorpusCase[] = [{ id: 'x', text: 'a', expectedHallucination: false, context: 'bc' }];
    expect(computeCorpusHash(a)).not.toBe(computeCorpusHash(b));
  });

  it('distinguishes an absent context from an empty-string context', () => {
    const a: CorpusCase[] = [{ id: 'x', text: 't', expectedHallucination: false }];
    const b: CorpusCase[] = [{ id: 'x', text: 't', expectedHallucination: false, context: '' }];
    expect(computeCorpusHash(a)).not.toBe(computeCorpusHash(b));
  });

  it('refuses an empty case set', () => {
    expect(() => computeCorpusHash([])).toThrow(InvalidCorpusError);
  });

  it('refuses duplicate case ids — hal_test_cases holds ~175 duplicates, so this guard is real', () => {
    const dup = [...cases(3), { id: 'c1', text: 'again', expectedHallucination: true }];
    expect(() => computeCorpusHash(dup)).toThrow(/duplicate case id/);
  });

  it('emits algo-prefixed full-length hex', () => {
    expect(computeCorpusHash(cases(3))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('corpus manifest', () => {
  it('records count and positive count', () => {
    const m = buildCorpusManifest({ corpusId: 'x-v1', cases: cases(10), builtAt: AT });
    expect(m.caseCount).toBe(10);
    expect(m.positiveCount).toBe(5);
  });

  it('refuses an unnamed corpus', () => {
    expect(() => buildCorpusManifest({ corpusId: '   ', cases: cases(3) })).toThrow(InvalidCorpusError);
  });

  it('builtAt is metadata and does not affect the hash', () => {
    const a = buildCorpusManifest({ corpusId: 'x', cases: cases(4), builtAt: new Date('2020-01-01') });
    const b = buildCorpusManifest({ corpusId: 'x', cases: cases(4), builtAt: new Date('2026-01-01') });
    expect(a.contentHash).toBe(b.contentHash);
    expect(isSameCorpus(a, b)).toBe(true);
  });

  it('describeCorpus cites id, short hash and count', () => {
    const m = buildCorpusManifest({ corpusId: 'hal-x-v1', cases: cases(7), builtAt: AT });
    const s = describeCorpus(m);
    expect(s).toContain('hal-x-v1@');
    expect(s).toContain(shortHash(m.contentHash));
    expect(s).toContain('(7 cases)');
  });
});

describe('the same corpus NAME over a changed case set is caught', () => {
  it('reports same-name-different-population explicitly', () => {
    // This is literally what happened: `hal_test_cases` grew 109 -> 1000 -> 2517 while the runs over
    // it were all labelled harness_version 1.0.0.
    const may = buildCorpusManifest({ corpusId: 'hal-corpus-v1', cases: cases(109), builtAt: AT });
    const july = buildCorpusManifest({ corpusId: 'hal-corpus-v1', cases: cases(1000), builtAt: AT });
    const fault = corpusComparabilityFault(may, july);
    expect(fault).toMatch(/same name, different population/);
    expect(fault).toContain('109 cases');
    expect(fault).toContain('1000 cases');
  });

  it('identity is decided by hash, not by id', () => {
    const a = buildCorpusManifest({ corpusId: 'name-a', cases: cases(5), builtAt: AT });
    const b = buildCorpusManifest({ corpusId: 'name-b', cases: cases(5), builtAt: AT });
    expect(isSameCorpus(a, b)).toBe(true); // same population, different labels
    expect(corpusComparabilityFault(a, b)).toBeNull();
  });
});

describe('recording an accuracy number without a ruler is REFUSED', () => {
  const matrix = { tp: 178, fp: 29, fn: 19, tn: 169 };

  it('throws when the ruler is absent', () => {
    expect(() => recordMeasurement({ matrix, ruler: undefined })).toThrow(MissingRulerError);
  });

  it('throws when the ruler is null', () => {
    expect(() => recordMeasurement({ matrix, ruler: null })).toThrow(MissingRulerError);
  });

  it('throws for a historical UNATTRIBUTED number', () => {
    expect(() => recordMeasurement({ matrix, ruler: UNATTRIBUTED })).toThrow(/UNATTRIBUTED/);
  });

  it('names every missing ruler component at once', () => {
    const broken = {
      corpus: { corpusId: '', contentHash: 'nope', caseCount: 0, positiveCount: 0, builtAt: '', sources: [] },
      width: { ...width(), strictness: 3 as unknown as 1 },
    } as unknown as MeasurementRuler;
    const faults = rulerFaults(broken);
    expect(faults.join(' | ')).toMatch(/corpusId is empty/);
    expect(faults.join(' | ')).toMatch(/contentHash is not a full/);
    expect(faults.join(' | ')).toMatch(/caseCount must be a positive integer/);
    expect(faults.join(' | ')).toMatch(/strictness must be 1 or 2/);
  });

  it('rejects a truncated hash — a short hash is a display form, not an identity', () => {
    const r = ruler();
    const truncated: MeasurementRuler = {
      ...r,
      corpus: { ...r.corpus, contentHash: shortHash(r.corpus.contentHash) },
    };
    expect(() => assertRuler(truncated)).toThrow(/contentHash is not a full/);
  });

  it('rejects a ruler describing fewer cases than were actually scored', () => {
    const small = ruler({ cases: cases(10) });
    expect(() => recordMeasurement({ matrix, ruler: small })).toThrow(
      /does not describe the population measured/,
    );
  });

  it('rejects an inverted observed family range', () => {
    expect(() => assertRuler(ruler({ width: { familiesMin: 3, familiesMax: 1 } }))).toThrow(
      /familiesMin \(3\) exceeds width.familiesMax \(1\)/,
    );
  });

  it('accepts a complete ruler and produces a citation naming corpus, hash, families and strictness', () => {
    const r = ruler({ cases: cases(400) });
    const m = recordMeasurement({ matrix, ruler: r });
    expect(m.citation).toMatch(/^F1 = 0\.8812 on corpus hal-test-v1@sha256:[0-9a-f]{12} \(400 cases\) at 2 families, strictness 2$/);
  });

  it('the citation is the required sentence shape for every metric', () => {
    const r = ruler({ cases: cases(400) });
    const m = recordMeasurement({ matrix, ruler: r, headline: 'recall' });
    expect(m.citation).toContain('RECALL = ');
    expect(m.citation).toContain('on corpus hal-test-v1@');
    expect(m.citation).toContain('strictness 2');
  });
});

describe('metrics use null for undefined, never a substituted denominator', () => {
  it('precision is null when nothing was predicted positive, but F1 is a defined 0', () => {
    // A real subtlety worth pinning: with tp=0, fp=0, fn=10 the harmonic-mean form of F1 is undefined
    // (precision has no denominator), but the equivalent count form 2tp/(2tp+fp+fn) = 0/10 IS defined
    // and equals 0. So precision is null while F1 is legitimately 0 — the detector found none of the
    // 10 positives. Only a genuinely empty denominator yields null.
    const m = metricsFromMatrix({ tp: 0, fp: 0, fn: 10, tn: 90 });
    expect(m.precision).toBeNull();
    expect(m.f1).toBe(0);
    expect(m.recall).toBe(0); // recall IS defined here: 0 of 10 positives found
  });

  it('an all-null matrix does not fabricate a zero', () => {
    const m = metricsFromMatrix({ tp: 0, fp: 0, fn: 0, tn: 0 });
    expect(m.precision).toBeNull();
    expect(m.recall).toBeNull();
    expect(m.f1).toBeNull();
    expect(m.accuracy).toBeNull();
  });

  it('formats a null metric as n/a rather than 0', () => {
    const s = formatMeasurement('f1', null, ruler());
    expect(s).toContain('F1 = n/a');
    expect(s).not.toContain('0.0000');
  });
});

describe('degraded width is visible in the ruler string', () => {
  it('marks DEGRADED when fewer families were reached than configured', () => {
    const s = describeWidth(width({ familiesConfigured: 5, familiesMin: 1, familiesMax: 3 }));
    expect(s).toContain('1-3 families (observed)');
    expect(s).toContain('[DEGRADED: configured 5]');
  });

  it('says nothing about degradation when the run met its configuration', () => {
    expect(describeWidth(width())).toBe('at 2 families, strictness 2');
  });
});

describe('comparing numbers taken with different rulers is REFUSED', () => {
  const matrix = { tp: 40, fp: 10, fn: 10, tn: 40 };

  it('refuses across different corpora', () => {
    const a = recordMeasurement({ matrix, ruler: ruler({ cases: cases(200, 'a') }) });
    const b = recordMeasurement({ matrix, ruler: ruler({ cases: cases(200, 'b') }) });
    expect(() => assertComparable(a, b)).toThrow(IncomparableMeasurementError);
  });

  it('refuses across different strictness — the two 2026-07-04 runs case', () => {
    const shared = cases(200);
    const a = recordMeasurement({ matrix, ruler: ruler({ cases: shared, width: { strictness: 1 } }) });
    const b = recordMeasurement({ matrix, ruler: ruler({ cases: shared, width: { strictness: 2 } }) });
    expect(() => assertComparable(a, b)).toThrow(/different strictness/);
  });

  it('refuses across different observed family width', () => {
    const shared = cases(200);
    const a = recordMeasurement({
      matrix,
      ruler: ruler({ cases: shared, width: { familiesConfigured: 1, familiesMin: 1, familiesMax: 1 } }),
    });
    const b = recordMeasurement({ matrix, ruler: ruler({ cases: shared }) });
    expect(() => assertComparable(a, b)).toThrow(/different observed family width/);
  });

  it('refuses across different quorum gating', () => {
    const shared = cases(200);
    const a = recordMeasurement({ matrix, ruler: ruler({ cases: shared }) });
    const b = recordMeasurement({
      matrix,
      ruler: ruler({ cases: shared, width: { decisionRequiresQuorum: false } }),
    });
    expect(() => assertComparable(a, b)).toThrow(/different quorum gating/);
  });

  it('allows comparison on an identical ruler', () => {
    const shared = cases(200);
    const a = recordMeasurement({ matrix, ruler: ruler({ cases: shared }) });
    const b = recordMeasurement({ matrix: { tp: 45, fp: 5, fn: 5, tn: 45 }, ruler: ruler({ cases: shared }) });
    expect(() => assertComparable(a, b)).not.toThrow();
  });
});

describe('historical numbers are marked unknown, never reconstructed', () => {
  it.each([0.34, 0.74, 0.886, 0.89])('renders %s as explicitly not comparable', (value) => {
    const s = formatUnattributed({
      metric: 'f1',
      value,
      quotedIn: 'prior handoffs',
      note: 'corpus and configuration could not be established from stored metadata',
    });
    expect(s).toContain('corpus UNKNOWN@UNKNOWN');
    expect(s).toContain('UNKNOWN families');
    expect(s).toContain('NOT COMPARABLE');
    expect(s).toContain(value.toFixed(4));
  });

  it('an unattributed number cannot be recorded as a measurement', () => {
    expect(() => recordMeasurement({ matrix: { tp: 1, fp: 1, fn: 1, tn: 1 }, ruler: UNATTRIBUTED })).toThrow(
      MissingRulerError,
    );
  });
});
