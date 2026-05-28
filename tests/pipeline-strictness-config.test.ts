/**
 * Unit tests for resolvePipelineStrictness — the HAL_STRICTNESS env override
 * for the score-event pipeline (CC config-flag PR, 2026-05-28).
 *
 * Contract:
 *   - unset  → 1 (identical to the original hardcode)
 *   - "1".."5" → that level
 *   - invalid / NaN / out-of-range → 1 (so a malformed env never silently
 *     flips the pipeline to evaluate()'s DEFAULT_STRICTNESS=4)
 */
import { resolvePipelineStrictness } from '../src/scoring/pipeline';

describe('resolvePipelineStrictness', () => {
  const original = process.env.HAL_STRICTNESS;
  afterEach(() => {
    if (original === undefined) delete process.env.HAL_STRICTNESS;
    else process.env.HAL_STRICTNESS = original;
  });

  it('defaults to 1 when HAL_STRICTNESS is unset', () => {
    delete process.env.HAL_STRICTNESS;
    expect(resolvePipelineStrictness()).toBe(1);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
  ])('maps HAL_STRICTNESS=%s → %i', (env, expected) => {
    process.env.HAL_STRICTNESS = env as string;
    expect(resolvePipelineStrictness()).toBe(expected);
  });

  it.each([['0'], ['6'], ['-1'], ['x'], ['']])(
    'clamps invalid/out-of-range HAL_STRICTNESS=%s → 1',
    (env) => {
      process.env.HAL_STRICTNESS = env as string;
      expect(resolvePipelineStrictness()).toBe(1);
    },
  );
});
