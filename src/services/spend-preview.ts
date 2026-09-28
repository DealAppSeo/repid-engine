/**
 * Fixed spend-preview fixture. Rates are 50 and 100.
 * applied stays false. This module inserts nothing.
 */

export const SPEND_PREVIEW_FIXTURE_RATES = [50, 100] as const;

export interface SpendPreview {
  rates: readonly [50, 100];
  applied: false;
  persisted: false;
}

export function previewSpendFixture(): SpendPreview {
  return {
    rates: SPEND_PREVIEW_FIXTURE_RATES,
    applied: false,
    persisted: false,
  };
}
