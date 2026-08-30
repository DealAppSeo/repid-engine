/**
 * The identity ladder, and the one rule that makes the chain resolution safe.
 *
 * `resolveIdentityState` exists so the passport can turn UNVERIFIED into a real answer. The
 * entire risk of doing that is the NOT_CHECKED case: if an unreachable RPC resolved UNVERIFIED
 * to NOT_MINTED, a transient outage would tell the world that live, provably-minted agents have
 * no on-chain identity — asserting an absence nobody observed, on the public passport.
 *
 * That is the same shape as the boolean #548 removed (an absence in our table published as a
 * fact about the chain) and the same shape as the settlement bug that cost twelve days
 * (NOT_CHECKED scored as a verdict). It is worth more than one assertion.
 */
import { describe, it, expect } from '@jest/globals';
import { deriveIdentityState, resolveIdentityState, type IdentityState } from '../src/services/identity-state';
import type { OnChainCheck } from '../src/services/erc8004-minter';

describe('deriveIdentityState — what the database alone supports', () => {
  it('a recorded mint tx is MINTED', () => {
    expect(deriveIdentityState({ mint_tx_hash: '0xabc', erc8004_token_id: '4444' })).toBe('MINTED');
    // …even with no token id recorded beside it.
    expect(deriveIdentityState({ mint_tx_hash: '0xabc' })).toBe('MINTED');
  });

  it('a token id with no mint tx is UNVERIFIED — never NOT_MINTED', () => {
    expect(deriveIdentityState({ erc8004_token_id: '4444' })).toBe('UNVERIFIED');
    expect(deriveIdentityState({ mint_tx_hash: null, erc8004_token_id: 4444 })).toBe('UNVERIFIED');
  });

  it('no token id at all is NOT_MINTED', () => {
    expect(deriveIdentityState({})).toBe('NOT_MINTED');
    expect(deriveIdentityState({ mint_tx_hash: null, erc8004_token_id: null })).toBe('NOT_MINTED');
  });

  it('an EMPTY-STRING token id is not a token id', () => {
    // The column is text and nullable; '' is the shape a careless write leaves behind, and
    // treating it as a token would put the agent in UNVERIFIED forever, pointing a chain
    // lookup at nothing.
    expect(deriveIdentityState({ erc8004_token_id: '' })).toBe('NOT_MINTED');
  });
});

describe('resolveIdentityState — folding in a chain answer', () => {
  it('NOT_CHECKED changes NOTHING, from any starting state', () => {
    // The rule the whole feature rests on. An unreachable RPC is a fact about our reach.
    for (const start of ['MINTED', 'UNVERIFIED', 'NOT_MINTED'] as IdentityState[]) {
      expect(resolveIdentityState(start, 'NOT_CHECKED')).toBe(start);
    }
  });

  it('UNVERIFIED + an owner on chain resolves to MINTED', () => {
    expect(resolveIdentityState('UNVERIFIED', 'OWNER_FOUND')).toBe('MINTED');
  });

  it('UNVERIFIED + a genuine revert resolves to NOT_MINTED', () => {
    // Only legitimate because the minter now distinguishes a revert from an unreached chain.
    expect(resolveIdentityState('UNVERIFIED', 'REVERTED')).toBe('NOT_MINTED');
  });

  it('a recorded mint tx is not downgraded by any chain answer', () => {
    // A revert against a recorded mint tx is a real contradiction and belongs in the drift
    // report from GET /:id/onchain. Silently flipping the passport would hide it.
    for (const check of ['OWNER_FOUND', 'REVERTED', 'NO_TOKEN', 'NOT_CHECKED'] as OnChainCheck[]) {
      expect(resolveIdentityState('MINTED', check)).toBe('MINTED');
    }
  });

  it('NOT_MINTED stays NOT_MINTED — there is nothing to look up', () => {
    for (const check of ['OWNER_FOUND', 'REVERTED', 'NO_TOKEN', 'NOT_CHECKED'] as OnChainCheck[]) {
      expect(resolveIdentityState('NOT_MINTED', check)).toBe('NOT_MINTED');
    }
  });

  it('an unexpected check value degrades to the honest state, never to an assertion', () => {
    expect(resolveIdentityState('UNVERIFIED', 'NO_TOKEN')).toBe('UNVERIFIED');
    expect(resolveIdentityState('UNVERIFIED', 'SOMETHING_NEW' as OnChainCheck)).toBe('UNVERIFIED');
  });
});
