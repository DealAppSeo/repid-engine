/**
 * T12 free-wave selector. Default off. Does not start a swarm and does not call a host.
 *
 * Diagnosis, 2026-09-25, from trinity-symphony-shared/lib/ConstitutionalAgentV4.js
 * (not this repo): heartbeat() writes presence with pgQuery. It does not call
 * an HTTP host. The same file's provider map does name an Anthropic messages
 * URL for model calls. That is not the heartbeat. This flag does not change
 * that file. When the flag is the exact string true, the named fallback order
 * is groq then cerebras. Anthropic is never selected.
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
