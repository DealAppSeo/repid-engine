/**
 * The passport `onchain` object: the live ownership read folded into the one call.
 *
 * Two things are pinned here, both honesty properties the house defect (NOT_CHECKED scored as a
 * verdict) keeps re-introducing:
 *
 *   1. `verified` is true ONLY for a non-zero owner read against the CANONICAL registry. A corrupt
 *      registry, a zero owner, a revert, or an unreached chain is verified=false — and a recorded
 *      mint is shown as MINTED either way, never downgraded to NOT_MINTED and never faked to a pass.
 *   2. The cache must never turn a chain blip into a lasting wrong answer: NOT_CHECKED is cached far
 *      more briefly than a real answer, a timeout yields NOT_CHECKED rather than hanging, and an
 *      unrecognised cache entry is ignored, not coerced into a verdict.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const cacheGet = jest.fn<(k: string) => Promise<string | null>>();
const cacheSet = jest.fn<(k: string, v: string, ttl?: number) => Promise<void>>();
jest.mock('../src/cache/dragonfly', () => ({
  cacheGet: (k: string) => cacheGet(k),
  cacheSet: (k: string, v: string, ttl?: number) => cacheSet(k, v, ttl),
}));

// eslint-disable-next-line import/first
import {
  buildPassportOnchain,
  isCanonicalRegistry,
  isVerified,
  type OnchainRead,
} from '../src/services/passport-onchain';
// eslint-disable-next-line import/first
import { resolveOnchainRead, type RawOnchainRead } from '../src/cache/passport-onchain-cache';
// eslint-disable-next-line import/first
import { ONCHAIN_IDENTITY_TTLS } from '../src/cache/onchain-identity-cache';

const CANONICAL = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ZERO = '0x0000000000000000000000000000000000000000';
const AN_OWNER = '0xdf6b82150000000000000000000000000000271d';
const offByOne = CANONICAL.slice(0, -1) + (CANONICAL.slice(-1) === 'e' ? 'f' : 'e');

const read = (over: Partial<OnchainRead> = {}): OnchainRead => ({
  check: 'OWNER_FOUND',
  owner: AN_OWNER,
  block: 21_500_000,
  registry: CANONICAL,
  chainId: 84532,
  verified_at: '2026-10-12T00:00:00.000Z',
  ...over,
});

describe('isCanonicalRegistry', () => {
  it('matches the canonical IdentityRegistry case-insensitively on the mint chain', () => {
    expect(isCanonicalRegistry(CANONICAL, 84532)).toBe(true);
    expect(isCanonicalRegistry(CANONICAL.toLowerCase(), 84532)).toBe(true);
    expect(isCanonicalRegistry(CANONICAL, null)).toBe(true); // null chain assumes Base Sepolia
  });
  it('rejects an off-by-one, a wrong chain, a zero and a nullish value', () => {
    expect(isCanonicalRegistry(offByOne, 84532)).toBe(false);
    expect(isCanonicalRegistry(CANONICAL, 8453)).toBe(false); // Base mainnet has no registry configured
    expect(isCanonicalRegistry(CANONICAL, 1)).toBe(false);
    expect(isCanonicalRegistry(null, 84532)).toBe(false);
    expect(isCanonicalRegistry(undefined, 84532)).toBe(false);
  });
});

describe('isVerified', () => {
  it('true only for OWNER_FOUND + non-zero owner + canonical registry', () => {
    expect(isVerified(read())).toBe(true);
  });
  it('false for a zero owner, a null owner, a non-canonical registry, a revert, or an unreached chain', () => {
    expect(isVerified(read({ owner: ZERO }))).toBe(false);
    expect(isVerified(read({ owner: null }))).toBe(false);
    expect(isVerified(read({ registry: offByOne }))).toBe(false);
    expect(isVerified(read({ check: 'REVERTED', owner: null }))).toBe(false);
    expect(isVerified(read({ check: 'NOT_CHECKED', owner: null, block: null }))).toBe(false);
  });
});

describe('buildPassportOnchain', () => {
  it('NOT_MINTED: no token and no mint tx — no read even when a reader is present', async () => {
    const reader = jest.fn(async () => read());
    const o = await buildPassportOnchain({ id: 'a', erc8004_token_id: null, mint_tx_hash: null }, reader);
    expect(reader).not.toHaveBeenCalled();
    expect(o.state).toBe('NOT_MINTED');
    expect(o).toMatchObject({ verified: false, owner: null, block: null, verified_at: null, check: 'NO_TOKEN' });
    // registry is still an address (the engine's registry), never null.
    expect(o.registry).toBe(CANONICAL);
  });

  it('MINTED without a reader: recorded state shown, verified=false, check NOT_CHECKED', async () => {
    const o = await buildPassportOnchain({ id: 'a', erc8004_token_id: '5', mint_tx_hash: '0xtx', mint_chain_id: 84532 });
    expect(o).toMatchObject({ state: 'MINTED', verified: false, owner: null, block: null, verified_at: null, check: 'NOT_CHECKED' });
  });

  it('a token id with no mint tx is still something to verify (MINTED here, not NOT_MINTED)', async () => {
    // #548: a token id is NOT "no identity". Without a reader it reads MINTED-unverified.
    const o = await buildPassportOnchain({ id: 'a', erc8004_token_id: '5', mint_tx_hash: null });
    expect(o.state).toBe('MINTED');
    expect(o.verified).toBe(false);
  });

  it('VERIFIED_ONCHAIN: a reader confirming a canonical owner read sets verified=true with owner/block/verified_at', async () => {
    const reader = jest.fn(async () => read({ block: 999, verified_at: '2026-10-12T01:02:03.000Z' }));
    const o = await buildPassportOnchain({ id: 'a', erc8004_token_id: '5', mint_tx_hash: '0xtx', mint_chain_id: 84532 }, reader);
    expect(reader).toHaveBeenCalledWith('a');
    expect(o).toEqual({
      state: 'VERIFIED_ONCHAIN',
      verified: true,
      owner: AN_OWNER,
      registry: CANONICAL,
      chainId: 84532,
      block: 999,
      verified_at: '2026-10-12T01:02:03.000Z',
      check: 'OWNER_FOUND',
    });
  });

  it('a corrupt-registry read on a recorded mint is MINTED, verified=false', async () => {
    const reader = jest.fn(async () => read({ registry: offByOne }));
    const o = await buildPassportOnchain({ id: 'a', erc8004_token_id: '5', mint_tx_hash: '0xtx' }, reader);
    expect(o.state).toBe('MINTED');
    expect(o.verified).toBe(false);
    expect(o.check).toBe('OWNER_FOUND'); // the read happened; it just does not verify
  });
});

describe('resolveOnchainRead — cache + timeout, never a lasting wrong answer', () => {
  beforeEach(() => {
    cacheGet.mockReset().mockResolvedValue(null);
    cacheSet.mockReset().mockResolvedValue(undefined);
  });

  const raw = (over: Partial<RawOnchainRead> = {}): RawOnchainRead => ({
    check: 'OWNER_FOUND', owner: AN_OWNER, block: 7, registry: CANONICAL, chainId: 84532, ...over,
  });

  it('a cache miss performs the read, stamps verified_at, and caches it for the LONG ttl', async () => {
    const r = await resolveOnchainRead('a', async () => raw());
    expect(r.check).toBe('OWNER_FOUND');
    expect(r.owner).toBe(AN_OWNER);
    expect(typeof r.verified_at).toBe('string');
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, , ttl] = cacheSet.mock.calls[0]!;
    expect(ttl).toBe(ONCHAIN_IDENTITY_TTLS.answer);
  });

  it('a NOT_CHECKED result is cached for the SHORT ttl — a blip must not pin the answer', async () => {
    await resolveOnchainRead('a', async () => raw({ check: 'NOT_CHECKED', owner: null, block: null }));
    const [, , ttl] = cacheSet.mock.calls[0]!;
    expect(ttl).toBe(ONCHAIN_IDENTITY_TTLS.notChecked);
    expect(ONCHAIN_IDENTITY_TTLS.notChecked).toBeLessThan(ONCHAIN_IDENTITY_TTLS.answer);
  });

  it('a read that never settles yields NOT_CHECKED instead of hanging', async () => {
    const started = Date.now();
    const r = await resolveOnchainRead('a', () => new Promise<RawOnchainRead>(() => {}), { timeoutMs: 20 });
    expect(r.check).toBe('NOT_CHECKED');
    expect(r.owner).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a rejected read yields NOT_CHECKED rather than propagating', async () => {
    const r = await resolveOnchainRead('a', async () => { throw new Error('rpc exploded'); }, { timeoutMs: 50 });
    expect(r.check).toBe('NOT_CHECKED');
  });

  it('a valid cache hit short-circuits the read, preserving its original verified_at', async () => {
    const cached: OnchainRead = { check: 'OWNER_FOUND', owner: AN_OWNER, block: 7, registry: CANONICAL, chainId: 84532, verified_at: '2026-01-01T00:00:00.000Z' };
    cacheGet.mockResolvedValue(JSON.stringify(cached));
    const reader = jest.fn(async () => raw());
    const r = await resolveOnchainRead('a', reader);
    expect(reader).not.toHaveBeenCalled();
    expect(r).toEqual(cached); // the original read time, not "now"
  });

  it('an unrecognised cache entry is IGNORED, not coerced into a verdict', async () => {
    cacheGet.mockResolvedValue('not-json-we-wrote');
    const r = await resolveOnchainRead('a', async () => raw());
    expect(r.check).toBe('OWNER_FOUND');
  });

  it('a cache entry with an unknown check string is ignored', async () => {
    cacheGet.mockResolvedValue(JSON.stringify({ check: 'MAYBE', owner: null, block: null, registry: CANONICAL, chainId: 84532, verified_at: 'x' }));
    const r = await resolveOnchainRead('a', async () => raw({ check: 'REVERTED', owner: null }));
    expect(r.check).toBe('REVERTED');
  });

  it('a cache READ failure does not decide the identity', async () => {
    cacheGet.mockRejectedValue(new Error('redis down'));
    const r = await resolveOnchainRead('a', async () => raw());
    expect(r.check).toBe('OWNER_FOUND');
  });

  it('a cache WRITE failure does not change the answer', async () => {
    cacheSet.mockRejectedValue(new Error('redis down'));
    const r = await resolveOnchainRead('a', async () => raw());
    expect(r.check).toBe('OWNER_FOUND');
  });
});
