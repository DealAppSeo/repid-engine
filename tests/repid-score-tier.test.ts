import { repidScoreTier } from '../src/services/repid-score-tier';

describe('GET /api/v1/repid/:id score and tier', () => {
  it('returns score and tier, and a missing id is NOT_CHECKED not 0', () => {
    expect(repidScoreTier({ score: 1299, tier: 'ESTABLISHED' })).toEqual({
      score: 1299,
      tier: 'ESTABLISHED',
    });
    const missing = repidScoreTier(null);
    expect(missing).toEqual({ score: 'NOT_CHECKED', tier: 'NOT_CHECKED' });
    expect(Object.keys(missing).sort()).toEqual(['score', 'tier']);
    expect(missing.score).not.toBe(0);
    expect(repidScoreTier({ score: null, tier: 'ESTABLISHED' }).score).not.toBe(0);
  });
});
