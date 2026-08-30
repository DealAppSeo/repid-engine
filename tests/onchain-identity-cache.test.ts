/**
 * The cache must never turn a chain outage into a lasting wrong answer.
 *
 * Two failure modes are being pinned, and both are ones a cache INTRODUCES rather than inherits:
 *
 *   1. A hang. MEASURED 2026-08-30: ethers' `JsonRpcProvider` against an unreachable endpoint
 *      does not fail — it logs "failed to detect network and cannot start up; retry in 1s" and
 *      keeps retrying. A probe ran two minutes and was still going. Unguarded in a request path,
 *      one RPC outage hangs every passport read.
 *
 *   2. A pinned failure. If NOT_CHECKED were cached for the same window as a real answer, a
 *      thirty-second blip would hold every agent at UNVERIFIED for two hours after the chain
 *      came back. Silent, and invisible in any dashboard that only looks at the RPC.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { OnChainCheck } from '../src/services/erc8004-minter';

const cacheGet = jest.fn<(k: string) => Promise<string | null>>();
const cacheSet = jest.fn<(k: string, v: string, ttl?: number) => Promise<void>>();
jest.mock('../src/cache/dragonfly', () => ({
  cacheGet: (k: string) => cacheGet(k),
  cacheSet: (k: string, v: string, ttl?: number) => cacheSet(k, v, ttl),
}));

import { resolveOnChainCheck, ONCHAIN_IDENTITY_TTLS } from '../src/cache/onchain-identity-cache';

const answer = (check: OnChainCheck) => async () => ({ check });

beforeEach(() => {
  cacheGet.mockReset().mockResolvedValue(null);
  cacheSet.mockReset().mockResolvedValue(undefined);
});

describe('resolveOnChainCheck', () => {
  it('a call that never settles yields NOT_CHECKED instead of hanging', async () => {
    const never = () => new Promise<{ check: OnChainCheck }>(() => {});
    const started = Date.now();
    const r = await resolveOnChainCheck('agent-1', never, { timeoutMs: 20 });
    expect(r.check).toBe('NOT_CHECKED');
    // The point is that it returns at all; the bound is what makes it safe in a request path.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a rejected call yields NOT_CHECKED rather than propagating', async () => {
    const boom = async () => { throw new Error('rpc exploded'); };
    await expect(resolveOnChainCheck('agent-1', boom, { timeoutMs: 50 })).resolves.toEqual({
      check: 'NOT_CHECKED',
      cached: false,
    });
  });

  it('a real answer is returned and cached for the LONG ttl', async () => {
    const r = await resolveOnChainCheck('agent-1', answer('OWNER_FOUND'));
    expect(r).toEqual({ check: 'OWNER_FOUND', cached: false });
    expect(cacheSet).toHaveBeenCalledWith('onchain-identity:agent-1', 'OWNER_FOUND', ONCHAIN_IDENTITY_TTLS.answer);
  });

  it('a NOT_CHECKED is cached for the SHORT ttl — a blip must not pin the answer', async () => {
    await resolveOnChainCheck('agent-1', answer('NOT_CHECKED'));
    expect(cacheSet).toHaveBeenCalledWith('onchain-identity:agent-1', 'NOT_CHECKED', ONCHAIN_IDENTITY_TTLS.notChecked);
    // The gap is the safety margin; if these ever converge the protection is gone.
    expect(ONCHAIN_IDENTITY_TTLS.notChecked).toBeLessThan(ONCHAIN_IDENTITY_TTLS.answer);
  });

  it('a cache hit short-circuits the chain call', async () => {
    cacheGet.mockResolvedValue('REVERTED');
    const verify = jest.fn(answer('OWNER_FOUND'));
    const r = await resolveOnChainCheck('agent-1', verify);
    expect(r).toEqual({ check: 'REVERTED', cached: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it('an unrecognised cache entry is IGNORED, not coerced into a verdict', async () => {
    // A stale format, a truncated write, someone else's key collision. None of those are an
    // answer about the chain, and treating an unknown string as one would be inventing a fact.
    cacheGet.mockResolvedValue('probably-fine');
    const r = await resolveOnChainCheck('agent-1', answer('OWNER_FOUND'));
    expect(r).toEqual({ check: 'OWNER_FOUND', cached: false });
  });

  it('a cache READ failure does not decide the identity', async () => {
    cacheGet.mockRejectedValue(new Error('redis down'));
    const r = await resolveOnChainCheck('agent-1', answer('OWNER_FOUND'));
    expect(r.check).toBe('OWNER_FOUND');
  });

  it('a cache WRITE failure does not change the answer', async () => {
    cacheSet.mockRejectedValue(new Error('redis down'));
    const r = await resolveOnChainCheck('agent-1', answer('OWNER_FOUND'));
    expect(r.check).toBe('OWNER_FOUND');
  });

  it('no Redis at all degrades to an always-miss, never to a wrong answer', async () => {
    cacheGet.mockResolvedValue(null);
    for (const check of ['OWNER_FOUND', 'REVERTED', 'NO_TOKEN', 'NOT_CHECKED'] as OnChainCheck[]) {
      const r = await resolveOnChainCheck('agent-x', answer(check));
      expect(r).toEqual({ check, cached: false });
    }
  });
});
