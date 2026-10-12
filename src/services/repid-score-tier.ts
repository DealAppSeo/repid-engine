/**
 * Public score card. Two fields. A missing id is NOT_CHECKED, never 0.
 * This module does not query or insert.
 *
 * It stays two fields on purpose. For a FOUND agent, GET /repid/:id spreads the ERC-8004 mint
 * block (repid-mint-status.ts) beside it; an unknown id gets exactly this card and nothing else.
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
