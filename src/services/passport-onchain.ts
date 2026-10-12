// The passport's `onchain` object: a LIVE ownership read folded into the passport payload, so a
// client gets the verified result in the ONE call it already makes instead of a second call to
// GET /api/v1/agents/:id/onchain per record (trustshell #523 was that interim second call).
//
// THREE STATES, NEVER TWO — and the honest boundary between them is the whole point:
//
//   NOT_MINTED        nothing is recorded (no token id and no mint tx). There is nothing to verify.
//   MINTED            a mint is recorded (a token id and/or a mint tx), but the live ownerOf read
//                     did NOT confirm it this request — because the read reverted, the registry it
//                     was bound to is not canonical, the owner is zero, OR the chain was not
//                     reached (NOT_CHECKED). The recorded state is still shown; `verified` is false.
//                     On-chain confirmation legitimately lags a recorded mint — that is expected and
//                     keeps mint-write costs down — so MINTED-but-unverified is a normal state, not a
//                     fault.
//   VERIFIED_ONCHAIN  the live read found a non-zero owner for exactly this token AND the registry
//                     the read was bound to is the canonical ERC-8004 IdentityRegistry. Only here is
//                     `verified` true.
//
// This never changes the semantics of identity_erc8004.registered_onchain (MINTED/UNVERIFIED/
// NOT_MINTED) — it is an ADDITIVE sibling that answers "did a live read confirm it?", which that
// field deliberately does not claim. A legacy token with no mint tx (the UNVERIFIED case there)
// reads here as MINTED when unverified: #548's lesson is that a token id is NOT "no identity", so it
// is something we can and do attempt to verify, not NOT_MINTED.
//
// `verified` is chain-gated and fail-safe: a NOT_CHECKED read (RPC unreachable, timeout) yields
// verified=false with the recorded state intact — never a pass, never a downgrade of a recorded
// mint. That is the same rule resolveIdentityState enforces: "we did not look" must not become an
// answer. `verified_at`/`block` come from the read itself (a verified field with no clock is the
// house defect); the raw `check` is surfaced so NOT_CHECKED stays visible rather than collapsing
// into a bare false.
import { ZeroAddress } from 'ethers';
import { canonicalIdentityRegistry } from '../identity/registry-address';
import { deriveIdentityState } from './identity-state';
import type { OnChainCheck } from './erc8004-minter';

/** Base Sepolia — the only chain this engine has minted identities on. Used as the chain fallback
 *  for a row that does not record one, matching canonicalIdentityRegistry(null)'s assumption. */
export const DEFAULT_MINT_CHAIN_ID = 84532;

export type OnchainState = 'NOT_MINTED' | 'MINTED' | 'VERIFIED_ONCHAIN';

/** The `onchain` object added to the passport payload. Additive — clients ignoring it still work. */
export interface PassportOnchain {
  state: OnchainState;
  /** true ONLY for VERIFIED_ONCHAIN: a non-zero owner for this token, read against the canonical registry. */
  verified: boolean;
  /** The owner address the live read returned, or null (no read, no owner, or chain not reached). */
  owner: string | null;
  /** The registry the read was bound to (always present — it is a constant of the engine, not a claim). */
  registry: string;
  chainId: number;
  /** The block the ownerOf read was as-of, or null when no live read landed on the chain. */
  block: number | null;
  /** When the read was taken (ISO), or null when no live read was taken. */
  verified_at: string | null;
  /**
   * The raw outcome of the live read, surfaced so three outcomes stay three:
   *   OWNER_FOUND  the chain answered with an owner.
   *   REVERTED     the chain answered: no such token.
   *   NOT_CHECKED  the chain was not reached (RPC down / timeout) — NOT a verdict.
   *   NO_TOKEN     nothing to look up (NOT_MINTED), or no reader wired this request.
   */
  check: OnChainCheck;
}

/** The result of one live read, as the resolver hands it to buildPassportOnchain (verified_at is
 *  stamped by the resolver, from the read). */
export interface OnchainRead {
  check: OnChainCheck;
  owner: string | null;
  block: number | null;
  registry: string;
  chainId: number;
  verified_at: string;
}

/** A live read for one agent. Injected so the pure composition stays testable without a chain. */
export type OnchainReader = (agentId: string) => Promise<OnchainRead>;

/** The row fields buildPassportOnchain needs. A subset of repid_agents. */
export interface OnchainRow {
  id: string;
  erc8004_token_id?: string | number | null;
  mint_tx_hash?: string | null;
  mint_chain_id?: number | null;
}

/**
 * Was the read bound to the canonical ERC-8004 IdentityRegistry for its chain? The canonical
 * address is single-sourced from config via canonicalIdentityRegistry (0x8004A818…BD9e on Base
 * Sepolia); an env override pointing the reader at a different registry correctly yields false.
 */
export function isCanonicalRegistry(registry: string | null | undefined, chainId: number | null): boolean {
  const canonical = canonicalIdentityRegistry(chainId);
  return !!canonical && typeof registry === 'string' && registry.toLowerCase() === canonical.toLowerCase();
}

/** verified === VERIFIED_ONCHAIN: a non-zero owner for this token, read against the canonical registry. */
export function isVerified(read: OnchainRead): boolean {
  return (
    read.check === 'OWNER_FOUND' &&
    typeof read.owner === 'string' &&
    read.owner !== ZeroAddress &&
    isCanonicalRegistry(read.registry, read.chainId)
  );
}

/**
 * Compose the passport `onchain` object from the DB row and (optionally) a live read.
 *
 * When no reader is injected, or nothing is recorded, no chain call is made and the object reflects
 * DB state alone with verified=false — honest: "not checked live" is not a pass. When a reader is
 * injected and a mint is recorded, one bounded read is taken (the reader owns the timeout/cache) and
 * its result decides VERIFIED_ONCHAIN vs MINTED.
 */
export async function buildPassportOnchain(
  row: OnchainRow,
  read?: OnchainReader,
): Promise<PassportOnchain> {
  const dbState = deriveIdentityState({
    mint_tx_hash: row.mint_tx_hash ?? null,
    erc8004_token_id: row.erc8004_token_id ?? null,
  });
  const recorded = dbState !== 'NOT_MINTED'; // a token id and/or a mint tx: something to verify
  const chainId = row.mint_chain_id ?? DEFAULT_MINT_CHAIN_ID;
  // Always an address: the registry the engine binds reads to for this chain (falling back to the
  // Base-Sepolia registry for a row with no / unknown chain). Not a claim that THIS agent is in it.
  const engineRegistry = canonicalIdentityRegistry(chainId) ?? canonicalIdentityRegistry(null)!;

  if (!recorded || !read) {
    return {
      state: recorded ? 'MINTED' : 'NOT_MINTED',
      verified: false,
      owner: null,
      registry: engineRegistry,
      chainId,
      block: null,
      verified_at: null,
      // NO_TOKEN when there is genuinely nothing to look up; NOT_CHECKED when there IS something
      // recorded but no live read was taken this request (no reader wired).
      check: recorded ? 'NOT_CHECKED' : 'NO_TOKEN',
    };
  }

  const r = await read(row.id);
  const verified = isVerified(r);
  return {
    state: verified ? 'VERIFIED_ONCHAIN' : 'MINTED',
    verified,
    owner: r.owner,
    registry: r.registry || engineRegistry,
    chainId: r.chainId ?? chainId,
    block: r.block,
    verified_at: r.verified_at,
    check: r.check,
  };
}
