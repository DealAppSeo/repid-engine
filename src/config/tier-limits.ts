export interface TierConfig {
  name: string;
  minRepId: number;
  pctOfStake: number;
}

export const BUILDER_TIERS: TierConfig[] = [
  { name: 'New', minRepId: 0, pctOfStake: 0.50 },
  { name: 'Tier 2', minRepId: 500, pctOfStake: 0.65 },
  { name: 'Tier 3', minRepId: 1000, pctOfStake: 0.80 },
  { name: 'Master', minRepId: 5000, pctOfStake: 0.95 },
  { name: 'Super', minRepId: 10000, pctOfStake: 1.00 },
];

export function getTierForRepId(repid: number): { current: TierConfig; next: TierConfig | null } {
  let current: TierConfig = BUILDER_TIERS[0] as TierConfig;
  let next: TierConfig | null = null;
  
  for (let i = 0; i < BUILDER_TIERS.length; i++) {
    const tier = BUILDER_TIERS[i];
    if (tier && repid >= tier.minRepId) {
      current = tier;
      const nextTier = BUILDER_TIERS[i + 1];
      next = nextTier ? nextTier : null;
    } else {
      break;
    }
  }
  
  return { current, next };
}