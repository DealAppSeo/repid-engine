/**
 * hal_classifications.model provenance (2026-07-08).
 *
 * Regression guard for the mislabel fix: the pipeline previously wrote a HARDCODED
 * model='deterministic-extractor' on every hal_classifications row, so the column
 * lied about which HAL path actually ran (124,990 rows all 'deterministic-extractor'
 * even when a real cross-LLM fact-check quorum produced the verdict — flagged by the
 * 06-28 BCBV blind pass). halClassificationModelLabel() derives the honest label from
 * the same signals the score event records (halMode + quorumMet). These tests pin that
 * mapping so a future refactor can't silently regress back to the hardcoded lie.
 */

import { halClassificationModelLabel } from '../src/scoring/pipeline';

describe('halClassificationModelLabel — honest HAL provenance', () => {
  test('real cross-LLM quorum → fact-check-quorum with families', () => {
    expect(
      halClassificationModelLabel({
        halError: null,
        halMode: 'fact-check',
        quorumMet: true,
        families: ['groq', 'gemini', 'deepseek'],
      }),
    ).toBe('fact-check-quorum:groq+gemini+deepseek');
  });

  test('real quorum with no families array → bare fact-check-quorum', () => {
    expect(
      halClassificationModelLabel({
        halError: null,
        halMode: 'fact-check',
        quorumMet: true,
        families: undefined,
      }),
    ).toBe('fact-check-quorum');
  });

  test('fact-check ran but no 2-family quorum → fact-check-partial (NOT deterministic-extractor)', () => {
    const label = halClassificationModelLabel({
      halError: null,
      halMode: 'fact-check',
      quorumMet: false,
      families: ['groq'],
    });
    expect(label).toBe('fact-check-partial');
    expect(label).not.toBe('deterministic-extractor');
  });

  test('fact-check degraded to extractor → extractor-fallback', () => {
    expect(
      halClassificationModelLabel({
        halError: null,
        halMode: 'extractor-fallback',
        quorumMet: false,
      }),
    ).toBe('extractor-fallback');
  });

  test('strictness-1 extractor path genuinely ran → deterministic-extractor (honest here)', () => {
    expect(
      halClassificationModelLabel({ halError: null, halMode: 'extractor', quorumMet: false }),
    ).toBe('deterministic-extractor');
    // halMode unset (legacy strictness-1) also maps to the honest extractor label.
    expect(
      halClassificationModelLabel({ halError: null, halMode: undefined, quorumMet: false }),
    ).toBe('deterministic-extractor');
  });

  test('HAL threw → hal-error-fallback (never a fabricated classification)', () => {
    // halError wins even if a stale halMode/quorumMet is present.
    expect(
      halClassificationModelLabel({
        halError: 'hal_failure: timeout',
        halMode: 'fact-check',
        quorumMet: true,
        families: ['groq', 'gemini'],
      }),
    ).toBe('hal-error-fallback');
  });

  test('the core regression: a real quorum is NEVER labelled deterministic-extractor', () => {
    const label = halClassificationModelLabel({
      halError: null,
      halMode: 'fact-check',
      quorumMet: true,
      families: ['groq', 'gemini'],
    });
    expect(label).not.toBe('deterministic-extractor');
    expect(label.startsWith('fact-check-quorum')).toBe(true);
  });
});
