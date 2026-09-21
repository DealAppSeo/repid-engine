import {
  classifyHeatTier,
  computeHeatScore,
  HeatLeaf,
  selectEvictionCandidates,
  selectReactivationCandidates,
} from '../../src/memory/memory-heat';

const NOW = 1_700_000_000_000; // fixed reference epoch
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 30 * DAY_MS;

describe('computeHeatScore', () => {
  it('zero-access leaf (never accessed) has 0 heat', () => {
    const heat = computeHeatScore(0, 0, NOW);
    expect(heat).toBe(0);
  });

  it('just-accessed leaf (age ≈ 0) is near 1', () => {
    const heat = computeHeatScore(NOW, 0, NOW);
    // recency = 1, frequency = 0 → RECENCY_WEIGHT * 1 ≈ 0.618
    expect(heat).toBeCloseTo(0.618, 2);
  });

  it('saturated-frequency leaf (accessCount ≥ 50) with zero recency = FREQUENCY_WEIGHT', () => {
    const heat = computeHeatScore(0, 50, NOW);
    // recency = 0, frequency = 1 → FREQUENCY_WEIGHT ≈ 0.382
    expect(heat).toBeCloseTo(0.382, 2);
  });

  it('30-day-old leaf has recency ≈ 0.5', () => {
    const lastAccessed = NOW - HALF_LIFE_MS;
    const heat = computeHeatScore(lastAccessed, 0, NOW);
    // recency = 0.5, frequency = 0 → 0.618 * 0.5 ≈ 0.309
    expect(heat).toBeCloseTo(0.309, 2);
  });

  it('high frequency compensates for stale recency', () => {
    const staleHeat = computeHeatScore(NOW - 60 * DAY_MS, 0, NOW);
    const frequentStaleHeat = computeHeatScore(NOW - 60 * DAY_MS, 50, NOW);
    expect(frequentStaleHeat).toBeGreaterThan(staleHeat);
  });
});

describe('classifyHeatTier', () => {
  it('heat > 0.6 is hot', () => {
    expect(classifyHeatTier(0.61)).toBe('hot');
    expect(classifyHeatTier(1.0)).toBe('hot');
  });

  it('heat = 0.6 is warm (boundary: hot requires strictly > 0.6)', () => {
    expect(classifyHeatTier(0.6)).toBe('warm');
  });

  it('heat in [0.3, 0.6] is warm', () => {
    expect(classifyHeatTier(0.3)).toBe('warm');
    expect(classifyHeatTier(0.45)).toBe('warm');
  });

  it('heat < 0.3 is cold', () => {
    expect(classifyHeatTier(0.29)).toBe('cold');
    expect(classifyHeatTier(0)).toBe('cold');
  });

  it('anchored leaf is on_chain regardless of heat', () => {
    expect(classifyHeatTier(0.9, true)).toBe('on_chain');
    expect(classifyHeatTier(0, true)).toBe('on_chain');
  });
});

function makeLeaf(id: string, lastAccessedMs: number, accessCount: number, isAnchored = false): HeatLeaf {
  return { id, lastAccessedMs, accessCount, isAnchored };
}

describe('selectEvictionCandidates', () => {
  it('returns empty array for empty input', () => {
    expect(selectEvictionCandidates([], 0.3, 10, NOW)).toEqual([]);
  });

  it('excludes leaves with heat above maxHeat', () => {
    const hotLeaf = makeLeaf('hot', NOW, 0);
    const result = selectEvictionCandidates([hotLeaf], 0.3, 10, NOW);
    expect(result).toHaveLength(0);
  });

  it('excludes anchored leaves', () => {
    const anchored = makeLeaf('anc', 0, 0, true);
    const result = selectEvictionCandidates([anchored], 0.3, 10, NOW);
    expect(result).toHaveLength(0);
  });

  it('returns candidates sorted ascending (coldest first), respects limit', () => {
    const cold1 = makeLeaf('c1', 0, 0); // heat = 0
    const cold2 = makeLeaf('c2', NOW - 10 * DAY_MS, 0); // some recency
    const result = selectEvictionCandidates([cold2, cold1], 0.3, 1, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c1'); // coldest wins
  });
});

describe('selectReactivationCandidates', () => {
  it('returns empty array for empty input', () => {
    expect(selectReactivationCandidates([], 0.3, NOW)).toEqual([]);
  });

  it('returns leaves with heat ≥ minHeat, sorted descending (warmest first)', () => {
    const warm = makeLeaf('w', NOW - 5 * DAY_MS, 0); // moderate heat
    const cold = makeLeaf('c', 0, 0); // heat = 0
    const result = selectReactivationCandidates([cold, warm], 0.1, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('w');
  });
});
