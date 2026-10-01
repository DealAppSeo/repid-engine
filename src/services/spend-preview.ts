/**
 * Fixed spend-preview fixture. Rates are 50 and 100 USDC.
 * eth and cbbtc are fixture numbers, not a quote.
 * applied stays false. sends_eth stays false.
 * This module sends nothing, inserts nothing, and does not read a stake row.
 */

export const SPEND_PREVIEW_FIXTURE_RATES = [50, 100] as const;

export const SPEND_PREVIEW_ASSET_FIXTURE = [
  { usdc: 50, eth: 1, cbbtc: 1 },
  { usdc: 100, eth: 2, cbbtc: 2 },
] as const;

export interface SpendPreview {
  rates: readonly [50, 100];
  assets: readonly { usdc: 50 | 100; eth: number; cbbtc: number }[];
  applied: false;
  persisted: false;
  sends_eth: false;
}

/**
 * stakeRows is the fixture stake table. Omit it, pass null, or pass [] when no
 * stake row exists. A row in that list still does not apply a spend or send ETH.
 */
export function previewSpendFixture(_stakeRows: readonly unknown[] | null = null): SpendPreview {
  return {
    rates: SPEND_PREVIEW_FIXTURE_RATES,
    assets: SPEND_PREVIEW_ASSET_FIXTURE,
    applied: false,
    persisted: false,
    sends_eth: false,
  };
}
