/**
 * S-CACHE Phase 5 — real-time provider health (5-minute windows in Redis).
 *
 * recordProviderCall bumps calls/success/fail counters; getProviderHealth reads the current window.
 * `healthy` = too few calls to judge (<5) OR success rate > 0.7. Graceful: no Redis → recording is a
 * no-op and health reads as healthy (don't penalize providers when we can't measure).
 */
import { cacheIncr, cacheGet } from './dragonfly';

const WINDOW_MS = 300_000; // 5 min
const WINDOW_TTL = 600;    // keep 2 windows

const windowIndex = () => Math.floor(Date.now() / WINDOW_MS);

export async function recordProviderCall(provider: string, success: boolean, _latencyMs?: number): Promise<void> {
  const prefix = `provider:${provider}`;
  const w = windowIndex();
  await cacheIncr(`${prefix}:calls:${w}`, WINDOW_TTL);
  await cacheIncr(`${prefix}:${success ? 'success' : 'fail'}:${w}`, WINDOW_TTL);
}

export interface ProviderHealth {
  provider: string; calls: number; success: number; fail: number; success_rate: number; healthy: boolean;
}

export async function getProviderHealth(provider: string): Promise<ProviderHealth> {
  const prefix = `provider:${provider}`;
  const w = windowIndex();
  const calls = parseInt((await cacheGet(`${prefix}:calls:${w}`)) || '0', 10);
  const success = parseInt((await cacheGet(`${prefix}:success:${w}`)) || '0', 10);
  const fail = parseInt((await cacheGet(`${prefix}:fail:${w}`)) || '0', 10);
  const success_rate = calls > 0 ? Math.round((success / calls) * 1000) / 1000 : 1.0;
  return { provider, calls, success, fail, success_rate, healthy: calls < 5 || success_rate > 0.7 };
}

export async function isProviderHealthy(provider: string): Promise<boolean> {
  return (await getProviderHealth(provider)).healthy;
}
