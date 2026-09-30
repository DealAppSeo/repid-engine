/**
 * Onboard layer from a counted receipt total.
 * 0 is layer 0, 1 is layer 1, and 3 is layer 3.
 * A missing table is NOT_CHECKED. It is never layer 0.
 * This module does not query or insert.
 */

export type OnboardLayer = { layer: number | 'NOT_CHECKED' };

export function onboardLayer(counted: number | 'NOT_CHECKED'): OnboardLayer {
  if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0) {
    return { layer: 'NOT_CHECKED' };
  }
  return { layer: counted };
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
