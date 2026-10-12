/**
 * The ERC-8004 "second factor" on the public score card: is there an identity token behind this
 * RepID, and what do we actually know about it.
 *
 * `GET /api/v1/repid/:id` used to return only { score, tier }, so every reader (the extension,
 * the CLI, the MCP server) reported mint state as null "because the endpoint does not return
 * it". The data was always on the row; `/passport/:id` already published it. This exposes the
 * same fields, derived by the SAME ladder (identity-state.ts) — not a second copy of it.
 *
 *   registered_onchain  MINTED / UNVERIFIED / NOT_MINTED, exactly as the passport states it.
 *                       MINTED means we hold the mint transaction. UNVERIFIED means a token id
 *                       exists with no mint tx recorded here: NOT "no identity" (tokens in that
 *                       state are live on chain) and not a claim either — it stays UNVERIFIED.
 *   erc8004_token_id    the token id as a string, or null when there is none.
 *   minted              the boolean the shipped TrustShell reader (src/lib/honest-contract.ts
 *                       repidHonesty) already looks for: true = MINTED, false = NOT_MINTED,
 *                       null = UNVERIFIED. Never `false` for "we did not look".
 *
 * Pure: no query, no chain read. `NOT_CHECKED` is not a value here — an unknown agent never
 * reaches this (the route answers its own NOT_CHECKED card, with no mint fields at all).
 */
import { deriveIdentityState, type IdentityRow, type IdentityState } from './identity-state';

export interface RepidMintStatus {
  erc8004_token_id: string | null;
  registered_onchain: IdentityState;
  minted: boolean | null;
}

export function repidMintStatus(row: IdentityRow): RepidMintStatus {
  const state = deriveIdentityState(row);
  const hasToken = row.erc8004_token_id != null && String(row.erc8004_token_id) !== '';
  return {
    erc8004_token_id: hasToken ? String(row.erc8004_token_id) : null,
    registered_onchain: state,
    minted: state === 'MINTED' ? true : state === 'NOT_MINTED' ? false : null,
  };
}
