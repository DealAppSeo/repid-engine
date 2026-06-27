import { ethers } from 'ethers';
import { getActiveNetwork } from '../config/network';
import { publishHealth, deriveBreakerState, getRoutingDecision, isEndpointHardDown } from '../resilience/health-bus';
import type { RoutingDecision, SurfaceHealth } from '../resilience/types';

let cachedProvider: ethers.AbstractProvider | null = null;
let cachedNetworkName: string | null = null;

/**
 * Returns a configured ethers provider for the active network.
 * If multiple RPC URLs are defined in network config, returns a FallbackProvider.
 * Otherwise, returns a standard JsonRpcProvider.
 * Caches the provider instance to avoid excessive instantiations.
 *
 * @param forceNew - If true, bypasses the cache and creates a new provider.
 */
export function getProvider(forceNew = false): ethers.AbstractProvider {
  const netConfig = getActiveNetwork();
  
  if (!forceNew && cachedProvider && cachedNetworkName === netConfig.name) {
    return cachedProvider;
  }

  const urls = netConfig.rpcUrls && netConfig.rpcUrls.length > 0
    ? netConfig.rpcUrls
    : (netConfig.rpcUrl ? [netConfig.rpcUrl] : []);

  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for network: ${netConfig.name}`);
  }

  let provider: ethers.AbstractProvider;

  if (urls.length > 1) {
    // FallbackProvider expects an array of JsonRpcProvider instances (or configs) in ethers v6
    const providers = urls.map(url => new ethers.JsonRpcProvider(url, undefined, {
      staticNetwork: true // Optimizes by bypassing chainId verification call if chainId is static
    }));
    provider = new ethers.FallbackProvider(providers);
  } else {
    provider = new ethers.JsonRpcProvider(urls[0], undefined, {
      staticNetwork: true
    });
  }

  cachedProvider = provider;
  cachedNetworkName = netConfig.name;

  return provider;
}

/**
 * Resets the cached provider. Useful for testing when switching networks dynamically.
 */
export function resetProviderCache(): void {
  cachedProvider = null;
  cachedNetworkName = null;
}

// ==================================================================================================
// B2 — multi-endpoint rotation + block-height health (ResilientSurface for the 'rpc' surface).
//
// Wraps a set of per-URL JsonRpcProviders. Each call tries endpoints in order, skipping any the
// health-bus has marked hard-down and honoring an ANFIS `RoutingDecision.preferredEndpoint` (when the
// rpc surface is enabled). Publishes one `SurfaceHealth` per URL. All-down throws a single clear error
// (RULE-8 — no hang). Flag `RPC_ROTATION_ENABLED` (default ON) — when fewer than 2 URLs resolve it
// degrades to single-provider behavior (== today). Keyed off ethers; no new deps.
// ==================================================================================================

const RPC_BREAKER_THRESHOLD = 3;
const RPC_BREAKER_COOLDOWN_MS = 60_000;
/** Block height older than this (vs the freshest seen) marks an endpoint stale. */
const RPC_STALE_BLOCK_LAG = 30;

interface RpcEndpointState {
  url: string;
  provider: ethers.JsonRpcProvider;
  consecutiveErrors: number;
  openUntil: number;
  latencyMsEwma: number;
  lastBlock: number | null;
  lastSuccessAt: number | null;
  lastError?: string;
}

let endpointStates: RpcEndpointState[] | null = null;
let endpointsNetworkName: string | null = null;

function rotationEnabled(): boolean {
  return process.env.RPC_ROTATION_ENABLED !== 'false';
}

function rpcSurfaceActuates(): boolean {
  // ANFIS preference is honored only when the rpc surface is explicitly enabled (default OFF).
  return process.env.RESILIENCE_ANFIS_ENABLE_RPC === 'true';
}

function buildEndpointStates(): RpcEndpointState[] {
  const net = getActiveNetwork();
  const urls = net.rpcUrls && net.rpcUrls.length > 0 ? net.rpcUrls : net.rpcUrl ? [net.rpcUrl] : [];
  if (urls.length === 0) throw new Error(`No RPC URLs configured for network: ${net.name}`);
  return urls.map((url) => ({
    url,
    provider: new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true }),
    consecutiveErrors: 0,
    openUntil: 0,
    latencyMsEwma: 0,
    lastBlock: null,
    lastSuccessAt: null,
  }));
}

function getEndpointStates(): RpcEndpointState[] {
  const net = getActiveNetwork();
  if (!endpointStates || endpointsNetworkName !== net.name) {
    endpointStates = buildEndpointStates();
    endpointsNetworkName = net.name;
  }
  return endpointStates;
}

function publishRpcHealth(s: RpcEndpointState): void {
  try {
    const open = Date.now() < s.openUntil;
    publishHealth({
      surface: 'rpc',
      endpoint: s.url,
      healthy: !open,
      state: deriveBreakerState(s.consecutiveErrors, s.openUntil, RPC_BREAKER_THRESHOLD),
      latencyMsEwma: s.latencyMsEwma,
      errorRate: s.consecutiveErrors > 0 ? Math.min(1, s.consecutiveErrors / RPC_BREAKER_THRESHOLD) : 0,
      lastSuccessAt: s.lastSuccessAt ?? undefined,
      lastError: s.lastError,
    });
  } catch {
    /* ignore */
  }
}

function markEndpointSuccess(s: RpcEndpointState, latencyMs: number, block?: number): void {
  s.consecutiveErrors = 0;
  s.openUntil = 0;
  s.lastSuccessAt = Date.now();
  s.lastError = undefined;
  s.latencyMsEwma = s.latencyMsEwma === 0 ? latencyMs : 0.3 * latencyMs + 0.7 * s.latencyMsEwma;
  if (typeof block === 'number') s.lastBlock = block;
  publishRpcHealth(s);
}

function markEndpointFailure(s: RpcEndpointState, err: unknown): void {
  s.consecutiveErrors += 1;
  s.lastError = err instanceof Error ? err.message : String(err);
  if (s.consecutiveErrors >= RPC_BREAKER_THRESHOLD) {
    s.openUntil = Date.now() + RPC_BREAKER_COOLDOWN_MS;
  }
  publishRpcHealth(s);
}

function isOpen(s: RpcEndpointState): boolean {
  return Date.now() < s.openUntil;
}

/** Thrown when every RPC endpoint is unavailable (clear, non-hanging — RULE-8). */
export class AllRpcEndpointsDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllRpcEndpointsDown';
  }
}

/**
 * Ping every endpoint with `eth_blockNumber`, recording latency + block height. Updates breaker state
 * and the freshest-block reference (used to flag a lagging endpoint as stale). Never throws; returns
 * the per-endpoint result for callers/tests.
 */
export async function rpcHealthPing(): Promise<SurfaceHealth[]> {
  const states = getEndpointStates();
  await Promise.all(
    states.map(async (s) => {
      const start = Date.now();
      try {
        const block = await s.provider.getBlockNumber();
        markEndpointSuccess(s, Date.now() - start, block);
      } catch (err) {
        markEndpointFailure(s, err);
      }
    })
  );
  // Stale-block check: any endpoint lagging the freshest by > RPC_STALE_BLOCK_LAG is treated as failing.
  const freshest = states.reduce((m, s) => (s.lastBlock !== null && s.lastBlock > m ? s.lastBlock : m), 0);
  if (freshest > 0) {
    for (const s of states) {
      if (s.lastBlock !== null && freshest - s.lastBlock > RPC_STALE_BLOCK_LAG) {
        // A lagging endpoint is unhealthy even if it answered: open its breaker so the wrapper rotates
        // away from it (a node serving an old chain head is worse than a node that errors cleanly).
        s.consecutiveErrors = Math.max(s.consecutiveErrors, RPC_BREAKER_THRESHOLD);
        s.openUntil = Date.now() + RPC_BREAKER_COOLDOWN_MS;
        s.lastError = `stale block height ${s.lastBlock} (freshest ${freshest})`;
        publishRpcHealth(s);
      }
    }
  }
  return states.map((s) => ({
    surface: 'rpc',
    endpoint: s.url,
    healthy: !isOpen(s),
    state: deriveBreakerState(s.consecutiveErrors, s.openUntil, RPC_BREAKER_THRESHOLD),
    latencyMsEwma: s.latencyMsEwma,
    errorRate: s.consecutiveErrors > 0 ? Math.min(1, s.consecutiveErrors / RPC_BREAKER_THRESHOLD) : 0,
    lastSuccessAt: s.lastSuccessAt ?? undefined,
    lastError: s.lastError,
  }));
}

/** Order endpoints for the next call: ANFIS preference (if enabled + healthy) first, then non-open. */
function orderedEndpoints(decision?: RoutingDecision): RpcEndpointState[] {
  const states = getEndpointStates();
  const live = states.filter((s) => !isOpen(s));
  const pool = live.length > 0 ? live : states; // if all open, still try (half-open probe) rather than hang
  const eff = decision ?? (rpcSurfaceActuates() ? getRoutingDecision('rpc') : undefined);
  const preferred = eff?.preferredEndpoint;
  if (preferred && !isEndpointHardDown('rpc', preferred)) {
    const idx = pool.findIndex((s) => s.url === preferred);
    if (idx > 0) {
      const [p] = pool.splice(idx, 1);
      pool.unshift(p!);
    }
  }
  return pool;
}

/**
 * Run an ethers read against the first healthy endpoint, rotating on error. `fn` receives a provider.
 * Honors an ANFIS routing preference when the rpc surface is enabled; the wrapper-health floor means a
 * preferred-but-hard-down endpoint is skipped (B5 fail-safe). Throws `AllRpcEndpointsDown` if every
 * endpoint fails.
 */
export async function rpcCall<T>(
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
  decision?: RoutingDecision
): Promise<T> {
  // Rotation off OR single endpoint → behave like the legacy single provider (today's behavior).
  if (!rotationEnabled() || getEndpointStates().length < 2) {
    const provider = getProvider() as ethers.JsonRpcProvider;
    return fn(provider);
  }

  const order = orderedEndpoints(decision);
  let lastErr: unknown;
  for (const s of order) {
    const start = Date.now();
    try {
      const result = await fn(s.provider);
      markEndpointSuccess(s, Date.now() - start);
      return result;
    } catch (err) {
      lastErr = err;
      markEndpointFailure(s, err);
    }
  }
  throw new AllRpcEndpointsDown(
    `All ${order.length} RPC endpoint(s) failed. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

/** Current per-URL health snapshots for the 'rpc' surface (ResilientSurface.health). */
export function rpcHealth(): SurfaceHealth[] {
  return getEndpointStates().map((s) => ({
    surface: 'rpc',
    endpoint: s.url,
    healthy: !isOpen(s),
    state: deriveBreakerState(s.consecutiveErrors, s.openUntil, RPC_BREAKER_THRESHOLD),
    latencyMsEwma: s.latencyMsEwma,
    errorRate: s.consecutiveErrors > 0 ? Math.min(1, s.consecutiveErrors / RPC_BREAKER_THRESHOLD) : 0,
    lastSuccessAt: s.lastSuccessAt ?? undefined,
    lastError: s.lastError,
  }));
}

/** Test-only: clear endpoint state. */
export function __resetRpcEndpoints(): void {
  endpointStates = null;
  endpointsNetworkName = null;
}
