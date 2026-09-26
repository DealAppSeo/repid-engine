/**
 * T12 free-wave selector. Default off. Does not start a swarm and does not call a host.
 * Heartbeat stays a SQL write. This module does not replace it.
 * On only when T12_FREE_WAVE is the exact string true. Order is groq then cerebras.
 */

export const T12_FREE_WAVE_ORDER = ['groq', 'cerebras'] as const;

export function t12FreeWaveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env === process.env ? process.env.T12_FREE_WAVE : env.T12_FREE_WAVE;
  return raw === 'true';
}

export function t12FreeWaveOrder(env: Record<string, string | undefined> = process.env): readonly string[] {
  if (!t12FreeWaveEnabled(env)) return [];
  return T12_FREE_WAVE_ORDER;
}
