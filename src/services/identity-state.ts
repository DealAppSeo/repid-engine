/**
 * The ONE identity ladder. There must not be a second.
 *
 * `MINTED / UNVERIFIED / NOT_MINTED` landed in #548 open-coded inside `agent-passport.ts`.
 * The moment a second consumer needed it — the registration response, and now the on-chain
 * resolution below — copying those two lines would have created exactly the defect this
 * codebase has already paid for four times over with the tier ladder: open-coded comparisons
 * that each disagree with the canonical one at a boundary, and nothing that fails when they
 * drift. So it is extracted here, unchanged in behaviour, before it acquires a second copy.
 *
 * Two functions, and the split is the point:
 *
 *   deriveIdentityState   what the DATABASE alone can support. No chain access.
 *   resolveIdentityState  folds a chain cross-check into that, and — the load-bearing rule —
 *                         NEVER lets "we could not check" change the answer.
 */

import type { OnChainCheck } from './erc8004-minter';

export type IdentityState = 'MINTED' | 'UNVERIFIED' | 'NOT_MINTED';

export interface IdentityRow {
  mint_tx_hash?: string | null;
  erc8004_token_id?: string | number | null;
}

/**
 * What our own table can honestly support, with no chain read.
 *
 * MINTED      we hold the mint transaction: the chain write is evidenced here.
 * UNVERIFIED  a token id exists but no mint tx is recorded. NOT "no identity" — it is
 *             "we have not looked", and #548 exists because it used to render as `false`.
 * NOT_MINTED  no token id at all. There is nothing to look up.
 */
export function deriveIdentityState(row: IdentityRow): IdentityState {
  const minted = !!row.mint_tx_hash;
  const hasToken = row.erc8004_token_id != null && String(row.erc8004_token_id) !== '';
  return minted ? 'MINTED' : hasToken ? 'UNVERIFIED' : 'NOT_MINTED';
}

/**
 * Fold an on-chain cross-check into the DB-derived state.
 *
 * THE RULE THAT MATTERS: `NOT_CHECKED` never changes anything. An unreachable RPC is a fact
 * about our reach, not about the chain, and resolving UNVERIFIED to NOT_MINTED on it would
 * publish an absence we never observed — on the public passport, for agents that are provably
 * on-chain. (`erc8004-minter.ts` had to be fixed first for this to even be expressible: it
 * previously reported every transport failure as `ownerOf reverted`, so a NOT_CHECKED was
 * indistinguishable from a REVERTED at this boundary.)
 *
 * A recorded mint tx is NOT downgraded by a chain answer here. If we hold a transaction and
 * `ownerOf` reverts, that is a genuine contradiction and deserves surfacing as drift by
 * `GET /:id/onchain`, which already computes it — quietly flipping the passport to NOT_MINTED
 * would hide a discrepancy rather than report it. Resolving UNVERIFIED is this function's job;
 * adjudicating a conflict is not.
 */
export function resolveIdentityState(dbState: IdentityState, check: OnChainCheck): IdentityState {
  if (dbState !== 'UNVERIFIED') return dbState;
  switch (check) {
    case 'OWNER_FOUND':
      return 'MINTED';
    case 'REVERTED':
      return 'NOT_MINTED';
    case 'NO_TOKEN':
      // Unreachable in practice — UNVERIFIED implies a token id. Defensive, and it degrades
      // to the honest state rather than asserting one from a case we did not expect.
      return 'UNVERIFIED';
    case 'NOT_CHECKED':
    default:
      return 'UNVERIFIED';
  }
}
