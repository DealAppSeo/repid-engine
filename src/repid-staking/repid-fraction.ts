export interface RepIDTier {
  min: number;
  max: number;
  fraction: number;
  label: string;
}

export const REPID_TIERS: RepIDTier[] = [
  { min: 0, max: 0, fraction: 0.00, label: 'RepID 0' },
  { min: 1, max: 99, fraction: 0.01, label: 'RepID 1-99' },
  { min: 100, max: 999, fraction: 0.05, label: 'RepID 100-999' },
  { min: 1000, max: 2999, fraction: 0.10, label: 'RepID 1000-2999' },
  { min: 3000, max: 4999, fraction: 0.20, label: 'RepID 3000-4999' },
  { min: 5000, max: 6999, fraction: 0.35, label: 'RepID 5000-6999' },
  { min: 7000, max: 8499, fraction: 0.50, label: 'RepID 7000-8499' },
  { min: 8500, max: 9499, fraction: 0.70, label: 'RepID 8500-9499' },
  { min: 9500, max: 9999, fraction: 0.85, label: 'RepID 9500-9999' },
  { min: 10000, max: Infinity, fraction: 1.00, label: 'RepID 10000+' }
];

export function fractionForRepID(repid: number): number {
  if (typeof repid !== 'number' || isNaN(repid)) {
    throw new Error('RepID must be a number');
  }
  if (repid < 0) {
    throw new Error('RepID cannot be negative');
  }
  const roundedRepid = Math.floor(repid); // Non-integer rounds down
  
  for (const tier of REPID_TIERS) {
    if (roundedRepid >= tier.min && roundedRepid <= tier.max) {
      return tier.fraction;
    }
  }
  
  // Should never be reached due to max: Infinity in the last tier
  return 0;
}
