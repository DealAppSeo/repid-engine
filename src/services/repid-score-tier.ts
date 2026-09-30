/**
 * Public score card. Two fields. A missing id is NOT_CHECKED, never 0.
 * This module does not query or insert.
 */

export interface RepidScoreTier {
  score: number | 'NOT_CHECKED';
  tier: string | 'NOT_CHECKED';
}

export function repidScoreTier(
  found: { score: number | null; tier: string | null } | null,
): RepidScoreTier {
  if (!found || typeof found.score !== 'number') {
    return { score: 'NOT_CHECKED', tier: 'NOT_CHECKED' };
  }
  const tier = typeof found.tier === 'string' && found.tier.length > 0 ? found.tier : 'NOT_CHECKED';
  return { score: found.score, tier };
}
