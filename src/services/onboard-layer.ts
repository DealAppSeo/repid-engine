/**
 * Onboard layer from a counted receipt total.
 * A count of 0 is layer 0. A missing count is NOT_CHECKED, never 0.
 * This module does not query or insert.
 */

export type OnboardLayer = { layer: number | 'NOT_CHECKED' };

export function onboardLayer(counted: number | 'NOT_CHECKED'): OnboardLayer {
  if (counted === 0) return { layer: 0 };
  return { layer: 'NOT_CHECKED' };
}

export async function readOnboardLayer(
  countReceipts: () => Promise<number | 'NOT_CHECKED'>,
): Promise<OnboardLayer> {
  try {
    return onboardLayer(await countReceipts());
  } catch {
    return { layer: 'NOT_CHECKED' };
  }
}
