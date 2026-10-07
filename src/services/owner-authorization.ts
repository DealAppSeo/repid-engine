/**
 * owner-authorization.ts — the owner's wallet, not a key, decides when an agent gets MORE power.
 *
 * TWO KEYS, TWO JOBS. An agent's API key does the work, inside limits. The wallet bound as its
 * owner (human-agent-binding.ts) changes the limits. A key can leak, live on a laptop, or sit with
 * us, and the damage it can do must stop at limits it cannot change. So every action that WIDENS
 * what an owned agent may do needs a fresh signature from that owner — not an API key, not the
 * agent, not an operator. Narrowing (revoke, stop, set a limit to 0) never needs it: making it
 * harder to stop an agent than to start one would be the wrong way round.
 *
 * WHAT IS SIGNED. An EIP-712 message, so the wallet shows the person readable fields instead of a
 * hex blob:
 *   subject    the agent id (or the account id, for stake)
 *   action     what is being authorized, from OWNER_ACTIONS
 *   params     keccak256 of the canonical JSON of the EXACT parameters — a signature for
 *              "grant read access" cannot be replayed as "grant write access"
 *   nonce      random, single-use
 *   expiresAt  unix seconds, at most MAX_LIFETIME_S ahead
 *
 * REPLAY. Each nonce is accepted once, remembered until it expires. The memory is this process's:
 * the API runs one replica [MEASURED 2026-10-04], and the lifetime cap means a restart re-opens a
 * window of at most ten minutes, for the identical action with identical parameters. Making that
 * window zero needs a table (an `owner_authorizations` ledger, which is also where provenance
 * belongs); that is DDL and lands separately.
 *
 * Smart wallets work: verification goes through wallet-signature.ts (ERC-1271 / ERC-6492), and a
 * chain it cannot reach yields `not_checked`, never a forged pass and never a false "bad signature".
 */
import { keccak256, toUtf8Bytes, isHexString } from 'ethers';
import { verifyWalletTypedData, type SignatureChain } from './wallet-signature';

export const OWNER_AUTH_DOMAIN = { name: 'HyperDAG Owner Authorization', version: '1', chainId: 84532 } as const;

export const OWNER_AUTH_TYPES = {
  OwnerAuthorization: [
    { name: 'subject', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'params', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

/** The actions that need the owner. Each names exactly what it widens. */
export const OWNER_ACTIONS = {
  'grant.mint': 'Give another agent permissions beyond read-only, from an agent you own',
  'keys.create': 'Issue a new API key for an agent you own',
  'stake.withdraw': 'Withdraw stake from your account',
} as const;
export type OwnerAction = keyof typeof OWNER_ACTIONS;

export const MAX_LIFETIME_S = 10 * 60;

/** What a caller sends alongside the action, as `owner_authorization` in the body. */
export interface OwnerAuthorizationInput {
  signature: string;
  nonce: string;
  expires_at: number;
}

export type OwnerAuthResult =
  | { ok: true; signer: string }
  | {
      ok: false;
      code:
        | 'owner_authorization_required'
        | 'malformed'
        | 'expired'
        | 'lifetime_too_long'
        | 'replayed'
        | 'bad_signature'
        | 'not_checked';
      message: string;
    };

/**
 * Canonical JSON: object keys sorted at every depth, arrays kept in order, no whitespace.
 * trustshell's lib/owner-auth.ts implements the same function; both test suites pin the same
 * vector, so the two cannot drift without one of them failing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

export function paramsHash(params: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(params)));
}

const usedNonces = new Map<string, number>();

function pruneNonces(nowS: number) {
  for (const [n, exp] of usedNonces) if (exp < nowS) usedNonces.delete(n);
}

/** Tests only. */
export function __resetOwnerAuthNonces(): void {
  usedNonces.clear();
}

/** Pull `owner_authorization` out of a request body without trusting its shape. */
export function readOwnerAuthorization(body: unknown): OwnerAuthorizationInput | null {
  const raw = (body as { owner_authorization?: unknown } | null)?.owner_authorization as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const { signature, nonce, expires_at } = raw;
  if (typeof signature !== 'string' || typeof nonce !== 'string') return null;
  const exp = Number(expires_at);
  if (!Number.isInteger(exp)) return null;
  return { signature, nonce, expires_at: exp };
}

/**
 * Is this the owner, approving this exact action with these exact parameters, now?
 * `expectedSigner` is resolved by the caller from the binding (or the account row) — never from
 * the request.
 */
export async function checkOwnerAuthorization(input: {
  subject: string;
  action: OwnerAction;
  params: unknown;
  auth: OwnerAuthorizationInput | null;
  expectedSigner: string;
  nowS?: number;
  chain?: SignatureChain;
}): Promise<OwnerAuthResult> {
  const nowS = input.nowS ?? Math.floor(Date.now() / 1000);
  const auth = input.auth;
  if (!auth) {
    return {
      ok: false,
      code: 'owner_authorization_required',
      message: `This needs approval from the agent's owner: ${OWNER_ACTIONS[input.action]}. Sign it in the owner's wallet and send it as owner_authorization.`,
    };
  }
  if (!isHexString(auth.nonce, 32)) {
    return { ok: false, code: 'malformed', message: 'nonce must be 32 bytes of hex.' };
  }
  if (auth.expires_at <= nowS) {
    return { ok: false, code: 'expired', message: 'The approval has expired. Sign a fresh one.' };
  }
  if (auth.expires_at > nowS + MAX_LIFETIME_S) {
    return { ok: false, code: 'lifetime_too_long', message: `An approval may last at most ${MAX_LIFETIME_S / 60} minutes.` };
  }
  pruneNonces(nowS);
  const nonceKey = auth.nonce.toLowerCase();
  if (usedNonces.has(nonceKey)) {
    return { ok: false, code: 'replayed', message: 'That approval was already used. Sign a fresh one.' };
  }

  // Reserve the nonce BEFORE the (async) signature check, so two concurrent requests carrying
  // the same approval cannot both pass; release it if the signature turns out bad, so a garbage
  // request cannot burn a real one.
  usedNonces.set(nonceKey, auth.expires_at);

  const value = {
    subject: input.subject,
    action: input.action,
    params: paramsHash(input.params),
    nonce: auth.nonce,
    expiresAt: auth.expires_at,
  };
  const checked = await verifyWalletTypedData(input.expectedSigner, OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, value, auth.signature, input.chain);
  if (!checked.ok) {
    usedNonces.delete(nonceKey);
    return checked.reason === 'not_checked'
      ? { ok: false, code: 'not_checked', message: `${checked.detail} Nothing was changed; try again in a moment.` }
      : {
          ok: false,
          code: 'bad_signature',
          message: "That approval was not signed by this agent's owner for exactly this action and these settings.",
        };
  }
  return { ok: true, signer: input.expectedSigner };
}
