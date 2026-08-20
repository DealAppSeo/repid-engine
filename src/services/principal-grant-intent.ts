/**
 * EIP-712 signed intent for a principal-to-principal grant mint.
 *
 * Closes a real gap in the first pass of principal-grants.ts: minting trusted
 * "whichever API key called this endpoint" as sufficient authorization for
 * grantor_agent_id, with no cryptographic proof the grantor actually consented
 * to THIS mint. Mirrors agent-delegation.ts's existing, already-established
 * pattern exactly: this module VERIFIES a signature the caller already
 * produced. It never signs anything itself and never touches
 * agent-wallet-manager.ts's getDecryptedPrivateKey() / the custodied-wallet
 * decryption path — that file's own header flags custody-key use as "human/
 * Sean review required" for a NEW purpose, and this follow-up does not take
 * that on. If repid-engine should ever auto-mint on an agent's behalf using
 * its custodied wallet, that is a separate, explicitly-flagged decision for a
 * later pass — not something to fold in here.
 *
 * Coverage today: measured 2026-08-20, 18 of 176 repid_agents rows have a
 * wallet_address (agent-wallet-manager.ts's provisioning is opt-in, not
 * retroactive). Hard-requiring a signature would refuse minting for the other
 * ~90% today, so this module reports signature status honestly rather than
 * gating on 100% coverage that does not exist yet — see principal-grants.ts's
 * mintGrant() for how NOT_CHECKED vs VERIFIED is decided and surfaced.
 */
import { verifyTypedData, getAddress } from 'ethers';
import type { Caveat } from './principal-caveat';
import { encodeCaveats } from './principal-caveat';

export const GRANT_INTENT_DOMAIN = {
  name: 'HyperDAG Principal Grant',
  version: '1',
  chainId: 84532, // Base Sepolia — same chain as DELEGATION_DOMAIN (agent-delegation.ts)
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

/**
 * Field names/order are part of the EIP-712 type hash — do not reorder or
 * rename without bumping GRANT_INTENT_DOMAIN.version (same rule
 * DELEGATION_TYPES documents).
 *   grantor          — the agent granting authority (must recover from signature)
 *   grantee          — the agent receiving it
 *   grantClass       — 'spend' | 'hot' | 'warm' | 'cold'
 *   capabilities     — sorted capability strings, signed as an array so the
 *                       signer sees exactly what is granted, not a hash of it
 *   caveatsEncoded   — encodeCaveats() output: canonical, sorted, so the
 *                       signed bytes are the bytes reconstructed (same
 *                       reasoning as caveat.ts's own encodeCaveats header)
 *   ttlSeconds       — requested lifetime; NOT the resulting expiresAt, since
 *                       the mint has not happened yet when this is signed
 *   idempotencyKey   — binds this signature to one specific mint attempt;
 *                       replaying it only ever re-confirms the same grant
 */
export const GRANT_INTENT_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  GrantIntent: [
    { name: 'grantor', type: 'string' },
    { name: 'grantee', type: 'string' },
    { name: 'grantClass', type: 'string' },
    { name: 'capabilities', type: 'string[]' },
    { name: 'caveatsEncoded', type: 'string' },
    { name: 'ttlSeconds', type: 'uint256' },
    { name: 'idempotencyKey', type: 'string' },
  ],
};

export interface GrantIntentMessage {
  grantor: string;
  grantee: string;
  grantClass: string;
  capabilities: string[];
  caveatsEncoded: string;
  ttlSeconds: number | bigint;
  idempotencyKey: string;
}

/** Build the canonical intent message from mint inputs. Pure — no signing, no DB. */
export function buildGrantIntentMessage(input: {
  grantorAgentId: string;
  granteeAgentId: string;
  grantClass: string;
  capabilities: string[];
  caveats: Caveat[];
  ttlSeconds: number;
  idempotencyKey: string;
}): GrantIntentMessage {
  return {
    grantor: input.grantorAgentId,
    grantee: input.granteeAgentId,
    grantClass: input.grantClass,
    capabilities: [...input.capabilities].sort(),
    caveatsEncoded: encodeCaveats(input.caveats),
    ttlSeconds: input.ttlSeconds,
    idempotencyKey: input.idempotencyKey,
  };
}

/** Return the (domain, types, message) triple a signer needs. Pure. */
export function buildGrantIntentTypedData(message: GrantIntentMessage) {
  return { domain: GRANT_INTENT_DOMAIN, types: GRANT_INTENT_TYPES, message };
}

/**
 * Recover the signer of a grant intent. Returns the checksummed address, or
 * null if the signature is malformed / does not recover (never throws).
 * Pure — no DB.
 */
export function recoverGrantIntentSigner(message: GrantIntentMessage, signature: string): string | null {
  try {
    return getAddress(verifyTypedData(GRANT_INTENT_DOMAIN, GRANT_INTENT_TYPES, message, signature));
  } catch {
    return null;
  }
}

export type SignatureCheck =
  | { required: false; status: 'NOT_CHECKED'; detail: string }
  | { required: true; status: 'VERIFIED'; recoveredAddress: string; detail: string }
  | { required: true; status: 'FAILED'; detail: string };

/**
 * Decide the signature outcome for a mint attempt. Pure — takes the grantor's
 * already-looked-up wallet_address (or null) rather than querying for it, so
 * this stays testable without a database.
 */
export function checkGrantIntentSignature(input: {
  grantorWalletAddress: string | null;
  message: GrantIntentMessage;
  signature: string | null;
}): SignatureCheck {
  if (!input.grantorWalletAddress) {
    return {
      required: false,
      status: 'NOT_CHECKED',
      detail: 'grantor has no repid_agents.wallet_address on record — signature cannot be required or checked',
    };
  }
  if (!input.signature) {
    return { required: true, status: 'FAILED', detail: 'grantor has a registered wallet_address but no signature was supplied' };
  }
  const recovered = recoverGrantIntentSigner(input.message, input.signature);
  if (!recovered) {
    return { required: true, status: 'FAILED', detail: 'signature is malformed or does not recover to any address' };
  }
  let expected: string;
  try {
    expected = getAddress(input.grantorWalletAddress);
  } catch {
    return { required: true, status: 'FAILED', detail: `grantor_wallet_address on record ('${input.grantorWalletAddress}') is not a valid address` };
  }
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    return { required: true, status: 'FAILED', detail: `signature recovers to ${recovered}, which does not match the grantor's registered wallet_address ${expected}` };
  }
  return { required: true, status: 'VERIFIED', recoveredAddress: recovered, detail: `signature verified against grantor's registered wallet_address ${expected}` };
}
