/**
 * stake-authorization.ts — who is allowed to credit a stake, and what they must prove.
 *
 * THE HOLE THIS CLOSES. `POST /api/v1/stake/deposit` was on the auth bypass list
 * (middleware/auth.ts) and took `builder_address` straight from the body. Anyone
 * who knew — or guessed — an address could credit stake to it, and stake is not
 * cosmetic: authority = sqrt(stake) x RepID-weighted score, and authority is what
 * gates operating an agent. An unauthenticated write to that is an unauthenticated
 * grant of capability on somebody else's account.
 *
 * FRICTION IS PROPORTIONAL TO VALUE AND RISK. That is the whole design, not a
 * slogan — a first-time visitor should not meet a wallet prompt, and a real
 * money credit should never be accepted on a cookie:
 *
 *   simulated stake   demo/onboarding money, no chain transfer. Grants authority,
 *                     so it still must be YOUR account: a full-account session
 *                     (Authorization: Bearer <login_token>) or an operator key.
 *                     Someone already signed in meets ZERO extra friction.
 *
 *   real stake        verified on-chain USDC. ALWAYS requires a wallet signature,
 *                     even from a signed-in session. A session proves you hold an
 *                     email login; a deposit credits value against a WALLET. Those
 *                     are different claims and collapsing them is how a weak proof
 *                     gets read as a strong one — the same mistake the SBT-vs-builder
 *                     split exists to prevent (see human-agent-binding.ts).
 *
 *   operator          REPID_API_KEYS service key, for the harness and demo scripts.
 *
 * WHY THE SIGNED MESSAGE CARRIES THE TX HASH. A signature over "credit me stake"
 * alone is a bearer token for every future deposit. The wallet, the amount and the
 * tx hash are all inside the signed text, so a captured signature cannot be
 * replayed for a different deposit, a larger amount, or another account. The
 * duplicate-tx_hash guard in stake-vault then stops the SAME deposit being
 * credited twice. Those two together are what make one signature safe to collect.
 *
 * WHY SIMULATED STAKE HAS NO SIGNATURE PATH. With no tx hash there is nothing to
 * bind a signature to, so it would be replayable — a worse proof than the session
 * it replaced. Session or operator only, deliberately.
 *
 * FAIL CLOSED. Enforcement is ON by default. `STAKE_DEPOSIT_AUTH_ENFORCED=false`
 * exists as a one-env-var rollback if it turns out a live caller was depending on
 * the old behaviour, and it logs LOUDLY every time it lets one through, because a
 * security control that can be disabled quietly is not a control (CLAUDE_RULES:
 * no silent degradation).
 */

import { verifyMessage } from 'ethers';
import { db } from '../db';
import { verifyFullAccountToken } from './auth-token';
import { matchEnvOperatorKey, validateAgentApiKey } from '../auth/api-keys';

/** Rollback valve. Default ON — this is a security control, so it fails closed. */
export const STAKE_DEPOSIT_AUTH_ENFORCED =
  (process.env.STAKE_DEPOSIT_AUTH_ENFORCED ?? 'true').toLowerCase() !== 'false';

export type StakeAuthTier = 'session' | 'wallet_signature' | 'operator' | 'unenforced';

export interface StakeAuthzResult {
  ok: boolean;
  /** How the caller proved they may credit this account. */
  tier?: StakeAuthTier;
  /** builders.id the deposit resolved to. Never taken from the request body. */
  builderId?: string;
  reason?:
    | 'no_credential'
    | 'invalid_session'
    | 'account_not_found'
    | 'not_your_account'
    | 'signature_required'
    | 'bad_signature';
  detail?: string;
}

export interface StakeAuthzInput {
  /** The address the caller wants credited. */
  builderAddress: string;
  /** Deposit amount in USDC smallest unit (6dp), as a string. */
  amount: string;
  /** Present only for a real, on-chain-backed deposit. */
  txHash?: string;
  /** EIP-191 personal_sign over stakeDepositMessage(...). */
  signature?: string;
  /** Raw `Authorization` header, if any. */
  authorizationHeader?: string;
  /** Raw `x-api-key` header, if any. */
  apiKeyHeader?: string;
}

/**
 * The exact text a wallet signs to credit a real deposit.
 *
 * Stable, human-readable, and specific enough that a person reading it in their
 * wallet can tell what they are agreeing to. Deliberately says that it moves no
 * funds — the transfer already happened; this only claims it.
 */
export function stakeDepositMessage(params: {
  wallet: string;
  amount: string;
  txHash: string;
}): string {
  return [
    'HyperDAG — credit stake deposit',
    '',
    `wallet: ${params.wallet.toLowerCase()}`,
    `amount: ${params.amount} (USDC, 6 decimals)`,
    `tx:     ${params.txHash.toLowerCase()}`,
    '',
    'Signing this credits the deposit above to your account.',
    'It moves no funds — that transfer already happened on-chain.',
  ].join('\n');
}

/** Recover the signer and compare. False on any malformed input, never throws. */
export function stakeSignatureMatches(
  wallet: string,
  message: string,
  signature: string,
): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

/** A real deposit is one that claims an on-chain transfer. */
export function isRealDepositClaim(txHash?: string): boolean {
  return typeof txHash === 'string' && txHash.length > 0 && !txHash.startsWith('simulated:');
}

function bearerFrom(header?: string): string | null {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const t = header.slice(7).trim();
  return t.length > 0 ? t : null;
}

/**
 * Decide whether this caller may credit a stake to this address.
 *
 * Resolution order is deliberate: the operator key is checked first so the
 * harness never depends on session plumbing, then the wallet signature (the
 * strongest user-held proof), then the session.
 */
export async function authorizeStakeDeposit(
  input: StakeAuthzInput,
): Promise<StakeAuthzResult> {
  const wallet = String(input.builderAddress ?? '').toLowerCase();
  const real = isRealDepositClaim(input.txHash);

  // The account has to exist before any of this means anything, and the wallet
  // comes from THAT ROW rather than from the caller.
  const { data: builder } = await db
    .from('builders')
    .select('id, address')
    .ilike('address', wallet)
    .maybeSingle();

  if (!STAKE_DEPOSIT_AUTH_ENFORCED) {
    // Loud, every time. An operator who disabled this should see it in the logs
    // rather than discover months later that the control was never on.
    console.warn(
      '[stake-authz] STAKE_DEPOSIT_AUTH_ENFORCED=false — crediting an UNAUTHENTICATED ' +
        `deposit to ${wallet} (real=${real}). This bypass is a rollback valve, not a setting.`,
    );
    return { ok: true, tier: 'unenforced', builderId: builder?.id };
  }

  if (!builder) {
    return {
      ok: false,
      reason: 'account_not_found',
      detail: 'No account is registered under that address.',
    };
  }

  // --- operator key -------------------------------------------------------
  // Service callers (harness, demo scripts, the settlement worker) present a
  // REPID_API_KEYS key and are trusted to name the account.
  const apiKey = input.apiKeyHeader ?? bearerFrom(input.authorizationHeader);
  if (apiKey) {
    if (matchEnvOperatorKey(apiKey)) {
      return { ok: true, tier: 'operator', builderId: builder.id };
    }
    // A DB-issued key (agent_api_keys) counts too — same fallback order the
    // global middleware uses. Unreachable DB must not read as "authorized".
    try {
      if (await validateAgentApiKey(apiKey)) {
        return { ok: true, tier: 'operator', builderId: builder.id };
      }
    } catch {
      /* fall through to the user-held proofs below */
    }
  }

  // --- wallet signature ---------------------------------------------------
  // Required for a real deposit; accepted (but not required) for a simulated one
  // is deliberately NOT offered — see the module header on replayability.
  if (real) {
    if (!input.signature) {
      return {
        ok: false,
        reason: 'signature_required',
        detail:
          'A real deposit must be claimed by a wallet signature. GET /api/v1/stake/deposit/message ' +
          'for the exact text to sign, then resend with `signature`.',
      };
    }
    const message = stakeDepositMessage({
      wallet,
      amount: String(input.amount),
      txHash: String(input.txHash),
    });
    if (!stakeSignatureMatches(wallet, message, input.signature)) {
      return {
        ok: false,
        reason: 'bad_signature',
        detail:
          'The signature did not recover to this wallet over this exact deposit ' +
          '(wallet, amount and tx hash are all inside the signed message).',
      };
    }
    return { ok: true, tier: 'wallet_signature', builderId: builder.id };
  }

  // --- session ------------------------------------------------------------
  // Simulated stake: being signed in to THIS account is enough, and costs a
  // returning user nothing.
  const token = bearerFrom(input.authorizationHeader);
  if (!token) {
    return {
      ok: false,
      reason: 'no_credential',
      detail:
        'Sign in first. Send your login_token as `Authorization: Bearer <token>`, ' +
        'or supply a real on-chain tx_hash with a wallet signature.',
    };
  }
  const session = verifyFullAccountToken(token);
  if (!session) {
    return { ok: false, reason: 'invalid_session', detail: 'Login token is invalid or expired.' };
  }
  if (session.builder_id !== builder.id) {
    return {
      ok: false,
      reason: 'not_your_account',
      detail: 'That address belongs to a different account.',
    };
  }
  return { ok: true, tier: 'session', builderId: builder.id };
}
