/**
 * P3 (sprint 2026-05-29): the live score-event pipeline path selector.
 * DEFAULT (HAL_STRICTNESS unset) MUST be 1 (extractor) = byte-identical to the
 * prior behavior; '2' routes through the discriminative fact-check scorer.
 * Anything else stays 1 (no malformed-env surprise).
 */
import { resolveHalStrictness } from '../src/scoring/pipeline';

describe('resolveHalStrictness (live HAL path selector)', () => {
  const orig = process.env.HAL_STRICTNESS;
  afterEach(() => { if (orig === undefined) delete process.env.HAL_STRICTNESS; else process.env.HAL_STRICTNESS = orig; });

  it('defaults to 1 (extractor) when unset — reversible no-op', () => {
    delete process.env.HAL_STRICTNESS;
    expect(resolveHalStrictness()).toBe(1);
  });
  it("routes to 2 (fact-check) only on exactly '2'", () => {
    process.env.HAL_STRICTNESS = '2';
    expect(resolveHalStrictness()).toBe(2);
  });
  it.each([['1'], ['3'], ['x'], [''], ['02']])('stays 1 for HAL_STRICTNESS=%s', (v) => {
    process.env.HAL_STRICTNESS = v as string;
    expect(resolveHalStrictness()).toBe(1);
  });
});
