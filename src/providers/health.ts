export interface HealthState {
  healthy: boolean;
  errorCount: number;
  lastError?: Error;
  resetAt?: number;
  lastSuccessAt?: number;
}

const healthMap = new Map<string, HealthState>();

export function getHealthState(provider: string): HealthState {
  if (!healthMap.has(provider)) {
    healthMap.set(provider, { healthy: true, errorCount: 0 });
  }
  return healthMap.get(provider)!;
}

export function isHealthy(provider: string): boolean {
  const state = getHealthState(provider);
  if (!state.healthy && state.resetAt && Date.now() > state.resetAt) {
    state.healthy = true;
    state.errorCount = 0;
    state.resetAt = undefined;
  }
  return state.healthy;
}

export function markFailure(provider: string, error: Error): void {
  const state = getHealthState(provider);
  state.errorCount += 1;
  state.lastError = error;
  if (state.errorCount >= 3) {
    state.healthy = false;
    state.resetAt = Date.now() + 60 * 1000; // 60s
  }
}

export function markSuccess(provider: string): void {
  const state = getHealthState(provider);
  state.errorCount = 0;
  state.healthy = true;
  state.lastSuccessAt = Date.now();
  state.resetAt = undefined;
}

export function markRateLimit(provider: string, retryAfterMs: number): void {
  const state = getHealthState(provider);
  state.healthy = false;
  state.resetAt = Date.now() + retryAfterMs;
}

export function recoverProviders(): void {
  for (const [provider, state] of healthMap.entries()) {
    if (!state.healthy && state.resetAt && Date.now() > state.resetAt) {
      state.healthy = true;
      state.errorCount = 0;
      state.resetAt = undefined;
    }
    if (!state.healthy && !state.resetAt) {
      state.healthy = true;
      state.errorCount = 0;
    }
  }
}

// Background poller
setInterval(recoverProviders, 30000);

export function getAllHealthStates() {
  const out: Record<string, any> = {};
  for (const [k, v] of healthMap.entries()) {
    out[k] = { ...v, isHealthy: isHealthy(k) };
  }
  return out;
}
