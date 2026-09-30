/**
 * Onboard layer from a counted receipt total.
 * A non-negative integer count is that layer. A missing count is NOT_CHECKED, never 0.
 * This module does not query or insert.
 */

export type OnboardLayer = { layer: number | 'NOT_CHECKED' };

export function onboardLayer(counted: number | 'NOT_CHECKED'): OnboardLayer {
  if (typeof counted === 'number' && Number.isInteger(counted) && counted >= 0) {
    return { layer: counted };
  }
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
