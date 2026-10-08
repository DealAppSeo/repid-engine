/**
 * Accepted-tokens policy — the HUMAN's gate on which tokens their agents may
 * settle in. This is the control surface Sean asked for: "the Human User can set
 * those in their settings for the agents to accept only certain tokens."
 *
 * The shape of the trust harness here: the human sets the allow-list; agents may
 * PROPOSE within it (convert, find a common token, rank cost); the policy decides
 * what is actually acceptable. The agent never widens its own mandate — proposing
 * a token outside the human's list is refused here, not negotiated.
 *
 * It is a PURE FILTER. It reads no chain, holds no funds, and persists nothing;
 * callers store the policy wherever user settings already live.
 *
 * FAIL-CLOSED, three ways, because the downstream of a wrong "accept" is money:
 *   1. No policy set        -> DEFAULT_ACCEPTED (USDC only). This preserves today's
 *      single-stable-token behaviour: an agent with no explicit human setting
 *      accepts exactly what the engine already settles in, nothing new.
 *   2. Unknown token        -> REFUSED. A symbol not in the registry is never
 *      accepted on faith; an attacker cannot smuggle in a look-alike symbol.
 *   3. NOT_CHECKED address  -> REFUSED even if the human listed it. A token whose
 *      address we have not verified can never be accepted for settlement, so a
 *      human cannot accidentally opt into an unconfirmed contract. Not proven is
 *      not acceptable.
 *
 * An empty allow-list ([]) is a DELIBERATE "accept nothing" and is honoured as
 * such — distinct from "no policy set", which falls back to the USDC default.
 */

import { getToken, isTransferReady } from './token-registry';

export interface AcceptedTokensPolicy {
  /**
   * The symbols this human permits their agents to accept. `undefined`/absent =
   * no policy set (USDC default). `[]` = accept nothing. Symbols are matched
   * case-insensitively against the registry.
   */
  accept?: readonly string[];
}

/** What an agent accepts when its human has set no policy: the one stable token
 *  the engine already settles in. Widening this is a human decision, not a default. */
export const DEFAULT_ACCEPTED = ['USDC'] as const;

export type PolicyDecision = 'ACCEPTED' | 'REFUSED';

export interface PolicyCheck {
  decision: PolicyDecision;
  symbol: string;
  reason:
    | 'in_policy'
    | 'default_usdc_only'
    | 'not_in_policy'
    | 'unknown_token'
    | 'address_not_verified'
    | 'policy_accepts_nothing';
  /** True when the decision came from the USDC fall-back, not an explicit list. */
  usedDefault: boolean;
  applied: false;
}

/** The effective allow-list: the human's list if set, otherwise the USDC default.
 *  Only transfer-ready symbols survive — a listed but NOT_CHECKED token is dropped. */
export function effectiveAcceptedTokens(policy?: AcceptedTokensPolicy): string[] {
  const usedDefault = !policy || policy.accept === undefined;
  const raw = usedDefault ? DEFAULT_ACCEPTED : (policy as AcceptedTokensPolicy).accept ?? [];
  const out: string[] = [];
  for (const s of raw) {
    const t = getToken(s);
    if (t && isTransferReady(t) && !out.includes(t.symbol)) out.push(t.symbol);
  }
  return out;
}

/**
 * Decide whether an agent may accept a proposed token under its human's policy.
 * Fail-closed on every ambiguity.
 */
export function checkAcceptedToken(
  proposedSymbol: unknown,
  policy?: AcceptedTokensPolicy,
): PolicyCheck {
  const usedDefault = !policy || policy.accept === undefined;
  const token = getToken(proposedSymbol);
  const symbol = token?.symbol ?? String(proposedSymbol);

  if (!token) {
    return { decision: 'REFUSED', symbol, reason: 'unknown_token', usedDefault, applied: false };
  }
  if (!isTransferReady(token)) {
    // Registry confidence is NOT_CHECKED (or address malformed) — refuse regardless
    // of what the human listed. A human cannot opt into an unverified contract.
    return { decision: 'REFUSED', symbol, reason: 'address_not_verified', usedDefault, applied: false };
  }

  // Explicit empty list means accept nothing.
  if (!usedDefault && (policy as AcceptedTokensPolicy).accept!.length === 0) {
    return { decision: 'REFUSED', symbol, reason: 'policy_accepts_nothing', usedDefault, applied: false };
  }

  const allowed = effectiveAcceptedTokens(policy);
  if (allowed.includes(token.symbol)) {
    return {
      decision: 'ACCEPTED',
      symbol: token.symbol,
      reason: usedDefault ? 'default_usdc_only' : 'in_policy',
      usedDefault,
      applied: false,
    };
  }
  return { decision: 'REFUSED', symbol: token.symbol, reason: 'not_in_policy', usedDefault, applied: false };
}
