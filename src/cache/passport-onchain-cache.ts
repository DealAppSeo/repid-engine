/**
 * Cached, timeout-guarded live ownership read for the passport `onchain` object.
 *
 * The passport is DB-first by design (no per-request RPC): the one place it now reaches the chain is
 * this read, and it is wrapped so a chain outage can never make the passport slow or wrong. Same two
 * load-bearing decisions as onchain-identity-cache.ts, and the TTL/timeout constants are IMPORTED
 * from there so there is one place to tune them, not two that drift:
 *
 *   1. A HARD TIMEOUT. ethers' JsonRpcProvider against an unreachable endpoint retries indefinitely
 *      rather than failing (MEASURED 2026-08-30), so an unguarded read hangs every passport request
 *      during an RPC outage. The call is raced against a deadline; a timeout is NOT_CHECKED.
 *   2. A FAILURE IS CACHED FAR MORE BRIEFLY THAN AN ANSWER. Caching NOT_CHECKED for the full answer
 *      window would pin every agent at MINTED-unverified for hours after the RPC recovered — a
 *      transient outage frozen into a lasting wrong answer, the failure a cache is most likely to
 *      introduce and least likely to show.
 *
 * Unlike onchain-identity-cache (which caches only the OnChainCheck enum), this stores the full read
 * — owner, block, chainId, registry, verified_at — because the passport needs those on a cache HIT
 * too. `verified_at` is the time the underlying read was taken, so a cache hit honestly reports WHEN
 * the chain was last read, not the hit time. This function never throws: every failure path yields
 * NOT_CHECKED.
 */
import { cacheGet, cacheSet } from './dragonfly';
import { ONCHAIN_IDENTITY_TTLS } from './onchain-identity-cache';
import { canonicalIdentityRegistry } from '../identity/registry-address';
import { DEFAULT_MINT_CHAIN_ID, type OnchainRead } from '../services/passport-onchain';
import type { OnChainCheck } from '../services/erc8004-minter';

const CACHE_PREFIX = 'passport-onchain:';
const VALID_CHECKS: readonly OnChainCheck[] = ['NO_TOKEN', 'OWNER_FOUND', 'REVERTED', 'NOT_CHECKED'];

/** The raw read the resolver wraps: everything in OnchainRead except verified_at (stamped here). */
export type RawOnchainRead = Omit<OnchainRead, 'verified_at'>;

function notCheckedRaw(): RawOnchainRead {
  return {
    check: 'NOT_CHECKED',
    owner: null,
    block: null,
    registry: canonicalIdentityRegistry(null)!,
    chainId: DEFAULT_MINT_CHAIN_ID,
  };
}

/**
 * Parse a cached entry back into an OnchainRead, or null when it is anything we do not recognise —
 * a stale format, a truncated write, a key collision. An unrecognised entry is NOT coerced into a
 * verdict; the caller falls through to a fresh read, exactly as onchain-identity-cache does.
 */
function parseCached(raw: string): OnchainRead | null {
  try {
    const v = JSON.parse(raw) as Partial<OnchainRead>;
    if (
      v &&
      typeof v.check === 'string' &&
      (VALID_CHECKS as readonly string[]).includes(v.check) &&
      (v.owner === null || typeof v.owner === 'string') &&
      (v.block === null || typeof v.block === 'number') &&
      typeof v.registry === 'string' &&
      typeof v.chainId === 'number' &&
      typeof v.verified_at === 'string'
    ) {
      return {
        check: v.check as OnChainCheck,
        owner: v.owner ?? null,
        block: v.block ?? null,
        registry: v.registry,
        chainId: v.chainId,
        verified_at: v.verified_at,
      };
    }
  } catch {
    // Not JSON we wrote. Fall through to a fresh read.
  }
  return null;
}

/**
 * Resolve the live ownership read for an agent, from cache when possible, otherwise `rawRead` raced
 * against a deadline. Stamps verified_at at read time, caches the full record (short TTL for
 * NOT_CHECKED, long TTL for a real answer), and never throws.
 */
export async function resolveOnchainRead(
  agentId: string,
  rawRead: (agentId: string) => Promise<RawOnchainRead>,
  opts: { timeoutMs?: number } = {},
): Promise<OnchainRead> {
  try {
    const hit = await cacheGet(CACHE_PREFIX + agentId);
    if (hit) {
      const parsed = parseCached(hit);
      if (parsed) return parsed;
    }
  } catch {
    // A cache read failure must never decide an identity. Fall through to the live read.
  }

  const timeoutMs = opts.timeoutMs ?? ONCHAIN_IDENTITY_TTLS.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  let raw: RawOnchainRead;
  try {
    raw = await Promise.race([
      rawRead(agentId),
      new Promise<RawOnchainRead>((resolve) => {
        timer = setTimeout(() => resolve(notCheckedRaw()), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch {
    raw = notCheckedRaw();
  } finally {
    if (timer) clearTimeout(timer);
  }

  const result: OnchainRead = { ...raw, verified_at: new Date().toISOString() };
  try {
    const ttl = raw.check === 'NOT_CHECKED' ? ONCHAIN_IDENTITY_TTLS.notChecked : ONCHAIN_IDENTITY_TTLS.answer;
    await cacheSet(CACHE_PREFIX + agentId, JSON.stringify(result), ttl);
  } catch {
    // Caching is an optimisation; failing to cache must not change the answer.
  }
  return result;
}
