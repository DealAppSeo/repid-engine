import { deriveHalDecision, resolveHalCategory } from '../src/scoring/pipeline';

// B1: category-aware soft veto. opinion + time-sensitive drove 65% of false vetoes on the
// labeled corpus; downgrade their HAL vetoes to 'flagged' when HAL_CATEGORY_SOFT_VETO=true,
// keep hard-veto for checkable categories and for critical Comma-BFT dissonance.

describe('resolveHalCategory', () => {
  it('maps known categories and defaults unknown to factual', () => {
    expect(resolveHalCategory('opinion')).toBe('opinion');
    expect(resolveHalCategory('Time-Sensitive')).toBe('time-sensitive');
    expect(resolveHalCategory('finance')).toBe('factual');
    expect(resolveHalCategory(undefined)).toBe('factual');
  });
});

describe('deriveHalDecision category-aware soft veto', () => {
  const orig = process.env.HAL_CATEGORY_SOFT_VETO;
  afterEach(() => { process.env.HAL_CATEGORY_SOFT_VETO = orig; });

  it('flag OFF (default): opinion veto stays a hard veto (zero behavior change)', () => {
    delete process.env.HAL_CATEGORY_SOFT_VETO;
    expect(deriveHalDecision(0.9, true, null, 'opinion')).toBe('vetoed');
    expect(deriveHalDecision(0.9, true, null, 'time-sensitive')).toBe('vetoed');
  });

  it('flag ON: opinion + time-sensitive vetoes downgrade to flagged', () => {
    process.env.HAL_CATEGORY_SOFT_VETO = 'true';
    expect(deriveHalDecision(0.9, true, null, 'opinion')).toBe('flagged');
    expect(deriveHalDecision(0.9, true, null, 'time-sensitive')).toBe('flagged');
  });

  it('flag ON: math / code / factual vetoes stay hard vetoes', () => {
    process.env.HAL_CATEGORY_SOFT_VETO = 'true';
    expect(deriveHalDecision(0.9, true, null, 'math')).toBe('vetoed');
    expect(deriveHalDecision(0.9, true, null, 'code')).toBe('vetoed');
    expect(deriveHalDecision(0.9, true, null, 'factual')).toBe('vetoed');
  });

  it('critical Comma-BFT severity is always a hard veto, even for soft categories', () => {
    process.env.HAL_CATEGORY_SOFT_VETO = 'true';
    expect(deriveHalDecision(0.1, false, 'critical', 'opinion')).toBe('vetoed');
  });

  it('non-veto paths unchanged (borderline → flagged, clean → clean)', () => {
    process.env.HAL_CATEGORY_SOFT_VETO = 'true';
    expect(deriveHalDecision(0.5, false, null, 'opinion')).toBe('flagged');
    expect(deriveHalDecision(0.1, false, null, 'opinion')).toBe('clean');
  });
});
