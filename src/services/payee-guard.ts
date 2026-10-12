import { ethers } from 'ethers';

/**
 * E-4 hardening — payee fail-closed.
 *
 * Several payment / x402 / settlement sites resolved a payee (recipient) with
 * `wallet_address || ZERO` or `?? ZERO`. Falling back to the zero address does
 * not fail — it quietly advertises, escrows or releases to a BURN as if it were
 * a valid payee. Money sent there is unrecoverable, and a 402 that advertises it
 * tells a paying caller to sign an authorization to nowhere.
 *
 * Three outcomes, never two: a real address passes, an unset / zero / malformed
 * payee is a REFUSAL — never a silent zero. This module is the one definition of
 * "payable" the payee-resolution sites share, so the rule cannot drift between
 * them.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * A payee is payable only when it is a syntactically valid EVM address that is
 * not the zero address. `ethers.isAddress(ZERO_ADDRESS)` is `true`, so the
 * explicit zero-address check is load-bearing — a stored zero is as much a burn
 * as an unset one.
 */
export function isPayableAddress(addr: unknown): addr is string {
  return (
    typeof addr === 'string' &&
    ethers.isAddress(addr) &&
    ethers.getAddress(addr) !== ethers.ZeroAddress
  );
}

/** Raised when a payee cannot be resolved to a real, non-zero address. */
export class PayeeUnsetError extends Error {
  readonly code = 'payee_unset';
  constructor(context: string) {
    super(
      `payee unset for ${context}: refusing to resolve a recipient to the zero address ` +
        `(that would advertise a burn as a valid payee)`,
    );
    this.name = 'PayeeUnsetError';
  }
}

/**
 * Fail-closed resolver: returns the checksummed payee, or throws
 * {@link PayeeUnsetError}. Use at a site that cannot proceed without a real
 * recipient, in place of a `|| ZERO` / `?? ZERO` fallback.
 */
export function requirePayableAddress(addr: unknown, context: string): string {
  if (!isPayableAddress(addr)) throw new PayeeUnsetError(context);
  return ethers.getAddress(addr);
}
