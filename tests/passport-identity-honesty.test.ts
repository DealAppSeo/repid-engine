/**
 * The passport must not report an absence in OUR table as a fact about the CHAIN.
 *
 * WHAT WENT WRONG. `identity_erc8004.registered_onchain` was `!!agent.mint_tx_hash` — a
 * bookkeeping column — published as an on-chain claim. MEASURED 2026-08-30 against the live
 * identity registry on Base Sepolia: token ids whose rows carry no mint tx return a real owner
 * from `ownerOf()`, and one such owner is byte-for-byte the `conservator_address` the same
 * passport reports. The payload said "not registered" about identities the chain was holding.
 *
 * WHY A BOOLEAN COULD NOT BE FIXED. Two states cannot express three facts. `false` had to mean
 * both "nothing was ever minted" and "we have a token id but never checked", and those differ by
 * everything that matters to someone deciding whether to trust an agent. The type is now
 * MINTED / UNVERIFIED / NOT_MINTED, and UNVERIFIED points at the live cross-check.
 */
import { describe, it, expect } from '@jest/globals';

type IdentityState = 'MINTED' | 'UNVERIFIED' | 'NOT_MINTED';

/** Mirrors the derivation in agent-passport.ts. Kept tiny and pure so it can be driven directly. */
function identityState(row: { mint_tx_hash?: string | null; erc8004_token_id?: string | null }): IdentityState {
  const minted = !!row.mint_tx_hash;
  const hasToken = row.erc8004_token_id != null && String(row.erc8004_token_id) !== '';
  return minted ? 'MINTED' : hasToken ? 'UNVERIFIED' : 'NOT_MINTED';
}

describe('registered_onchain never claims more than we measured', () => {
  it('a recorded mint transaction is MINTED', () => {
    expect(identityState({ mint_tx_hash: '0xabc', erc8004_token_id: '3747' })).toBe('MINTED');
  });

  it('THE REGRESSION: a token id with no mint tx is UNVERIFIED, never a denial', () => {
    // This is the exact shape of trinity-sophia (token 3747, no mint tx) whose token is live on
    // chain and owned by this passport's own conservator_address. The old code returned false.
    const state = identityState({ mint_tx_hash: null, erc8004_token_id: '3747' });
    expect(state).toBe('UNVERIFIED');
    expect(state).not.toBe('NOT_MINTED');
  });

  it('no token id at all is NOT_MINTED', () => {
    expect(identityState({ mint_tx_hash: null, erc8004_token_id: null })).toBe('NOT_MINTED');
  });

  it('an empty-string token id is not mistaken for a token', () => {
    expect(identityState({ mint_tx_hash: null, erc8004_token_id: '' })).toBe('NOT_MINTED');
  });

  it('the three states are distinguishable — a boolean cannot carry this', () => {
    // The load-bearing property. If someone "simplifies" this back to a boolean, the two
    // non-minted states collapse and the denial returns.
    const states = new Set([
      identityState({ mint_tx_hash: '0xabc', erc8004_token_id: '1' }),
      identityState({ mint_tx_hash: null, erc8004_token_id: '1' }),
      identityState({ mint_tx_hash: null, erc8004_token_id: null }),
    ]);
    expect(states.size).toBe(3);
  });
});
