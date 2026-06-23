/**
 * HAL_STRICT_MODE switch.
 *
 * Default false (graceful — correct for production: a missing provider or HAL
 * failure should not break user-facing requests). Set true in test/measurement
 * contexts so silent degradations become loud, immediate failures and we never
 * measure a degraded pipeline and call the result a baseline.
 *
 * Usage: wrap an existing graceful-degradation catch body so the EXISTING
 * behavior becomes the `fallback` arg. When HAL_STRICT_MODE !== 'true' the
 * fallback runs exactly as before (production byte-identical); when it is
 * 'true' the degradation throws with the failure context attached.
 */
export function isStrictMode(): boolean {
  return process.env.HAL_STRICT_MODE === 'true';
}

export function strictModeOrFallback<T>(
  context: string,
  err: unknown,
  fallback: () => T,
): T {
  const msg = err instanceof Error ? err.message : String(err);
  if (isStrictMode()) {
    throw new Error(`STRICT MODE FAIL: ${context}: ${msg}`);
  }
  console.warn(`[graceful degradation] ${context}: ${msg}`);
  return fallback();
}
