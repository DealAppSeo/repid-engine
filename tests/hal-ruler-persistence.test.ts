/**
 * HAL ruler persistence (shadow, flag-gated). Pure: no DB, no network.
 *
 * Closes the gap where a rulered measurement lost its ruler when saved to
 * hal_validation_summaries (two runs over the same 1000 ids were stored as F1 0.344 and 0.798
 * under one harness_version). Write path: buildSummaryRow — HAL_PERSIST_RULER off = the historical
 * row unchanged; on = serialize the ruler and REFUSE an UNRULED summary. Read path:
 * formatStoredMeasurement — a null/invalid stored ruler renders UNATTRIBUTED, a valid one cites.
 */
jest.mock('../src/db', () => ({ db: {} }));

import {
  MeasurementRuler,
  RuledMeasurement,
  recordMeasurement,
  serializeRuler,
  rulerFromStored,
  rulerFaults,
  formatStoredMeasurement,
} from '../src/hal/measurement-ruler';
import { buildCorpusManifest } from '../src/hal/corpus-manifest';
import { buildSummaryRow, UnruledSummaryError } from '../src/services/hal-validation-runner';

function validRuler(): MeasurementRuler {
  const corpus = buildCorpusManifest({
    corpusId: 'hal-test-v1',
    cases: [
      { id: 'a', text: 'alpha', expectedHallucination: true },
      { id: 'b', text: 'bravo', expectedHallucination: false },
      { id: 'c', text: 'charlie', expectedHallucination: true },
      { id: 'd', text: 'delta', expectedHallucination: false },
    ],
  });
  return {
    corpus,
    width: {
      familiesConfigured: 2,
      familiesMin: 2,
      familiesMax: 2,
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: false,
    },
  };
}

function ruledMeasurement(): RuledMeasurement {
  return recordMeasurement({ matrix: { tp: 1, fp: 0, fn: 1, tn: 2 }, ruler: validRuler() });
}

const HISTORICAL_KEYS = [
  'run_id', 'total_cases', 'correct_cases', 'accuracy', 'precision_score', 'recall_score',
  'f1_score', 'false_positives', 'false_negatives', 'true_positives', 'true_negatives',
  'by_category', 'by_difficulty', 'harness_version',
].sort();

const baseArgs = () => ({
  runId: 'run-1',
  measurement: ruledMeasurement(),
  byCategory: {} as Record<string, unknown>,
  byDifficulty: {} as Record<string, unknown>,
  harnessTag: '2.0.0|hal-test-v1@x',
});

describe('write path: buildSummaryRow', () => {
  it('HAL_PERSIST_RULER off: row is the historical payload, no ruler key', () => {
    const row = buildSummaryRow({ ...baseArgs(), persistRuler: false });
    expect('ruler' in row).toBe(false);
    expect(Object.keys(row).sort()).toEqual(HISTORICAL_KEYS);
  });

  it('HAL_PERSIST_RULER on + ruled measurement: serializes the full ruler, which round-trips', () => {
    const m = ruledMeasurement();
    const row = buildSummaryRow({ ...baseArgs(), measurement: m, persistRuler: true });
    expect(row.ruler).toEqual(serializeRuler(m.ruler));
    expect(row.ruler).toEqual({
      corpus: { corpusId: 'hal-test-v1', contentHash: m.ruler.corpus.contentHash, caseCount: 4 },
      width: {
        familiesConfigured: 2, familiesMin: 2, familiesMax: 2,
        strictness: 2, decisionRequiresQuorum: true, penaltyRequiresQuorum: false,
      },
    });
    // Round-trips through jsonb and still validates + cites.
    const roundTripped = JSON.parse(JSON.stringify(row.ruler));
    expect(rulerFaults(rulerFromStored(roundTripped))).toEqual([]);
    expect(formatStoredMeasurement('f1', row.f1_score as number, roundTripped)).toContain('on corpus hal-test-v1@');
  });

  it('HAL_PERSIST_RULER on + UNRULED summary: refused (never recorded)', () => {
    const unruled = {
      matrix: { tp: 1, fp: 0, fn: 1, tn: 2 },
      metrics: { f1: 0.5, precision: 1, recall: 0.5, accuracy: 0.75, false_positive_rate: 0 },
      ruler: { corpus: { corpusId: 'x', contentHash: 'not-a-hash', caseCount: 4 }, width: validRuler().width },
      citation: '',
    } as unknown as RuledMeasurement;
    expect(() => buildSummaryRow({ ...baseArgs(), measurement: unruled, persistRuler: true })).toThrow(
      UnruledSummaryError,
    );
  });
});

describe('read path: formatStoredMeasurement', () => {
  it('a ruler-null row surfaces as UNATTRIBUTED: visibly un-sourced, never comparable', () => {
    const s = formatStoredMeasurement('f1', 0.8812, null);
    expect(s).toContain('NOT COMPARABLE');
    expect(s).toContain('provenance never established');
    expect(s).toContain('UNKNOWN');
  });

  it('a rulered row surfaces with its citation', () => {
    const s = formatStoredMeasurement('f1', 0.8812, serializeRuler(validRuler()));
    expect(s).toContain('F1 = 0.8812');
    expect(s).toContain('on corpus hal-test-v1@');
    expect(s).toContain('at 2 families, strictness 2');
    expect(s).not.toContain('NOT COMPARABLE');
  });

  it('a garbled stored ruler is UNATTRIBUTED, never fabricated into a measurement', () => {
    const s = formatStoredMeasurement('f1', 0.8812, { corpus: { corpusId: 'x' } });
    expect(s).toContain('NOT COMPARABLE');
    expect(s).toContain('provenance never established');
  });
});
