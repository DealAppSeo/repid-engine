import { deriveHalDecision } from '../src/scoring/pipeline';

describe('deriveHalDecision', () => {
  it("vetoed=true, score=0.30 → 'vetoed'", () => {
    expect(deriveHalDecision(0.30, true)).toBe('vetoed');
  });

  it("vetoed=true, score=0.10 → 'vetoed'", () => {
    expect(deriveHalDecision(0.10, true)).toBe('vetoed');
  });

  it("vetoed=false, score=0.55 → 'flagged'", () => {
    expect(deriveHalDecision(0.55, false)).toBe('flagged');
  });

  it("vetoed=false, score=0.40 (boundary) → 'flagged'", () => {
    expect(deriveHalDecision(0.40, false)).toBe('flagged');
  });

  it("vetoed=false, score=0.39 → 'clean'", () => {
    expect(deriveHalDecision(0.39, false)).toBe('clean');
  });

  it("vetoed=false, score=0.10 → 'clean'", () => {
    expect(deriveHalDecision(0.10, false)).toBe('clean');
  });

  it("vetoed=false, comma_severity='critical' → 'vetoed' (override)", () => {
    expect(deriveHalDecision(0.30, false, 'critical')).toBe('vetoed');
  });

  it("vetoed=false, comma_severity='major' → derive from score normally", () => {
    expect(deriveHalDecision(0.30, false, 'major')).toBe('clean');
    expect(deriveHalDecision(0.45, false, 'major')).toBe('flagged');
  });
});
