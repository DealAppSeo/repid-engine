/**
 * signed-policy.ts — the TrustKeys "reference tier" POLICY LIFECYCLE: register once, REVOKE later.
 *
 * WHAT THIS ADDS (and does NOT change). PR #1273 (src/services/signed-job.ts) verifies a job against
 * a policy handed INLINE on every request. This module lets an owner REGISTER a signed policy once so
 * later jobs can be verified against it, and — the point of the whole exercise — REVOKE it. It stores
 * state AROUND the existing signed objects; it does NOT add a field to the signed job or signed policy
 * format. The canonicalizer, the Policy shape, and hashPayee are IMPORTED from signed-job.ts, never
 * reimplemented, so a parallel client signer stays byte-for-byte compatible.
 *
 * STILL NOT CUSTODIAL, STILL NO KEY ON OUR DISK (Sean, 2026-10-08). A policy is addresses-as-hashes +
 * a cap + a signature, never a secret. No key column, no ciphertext, no master key, no decrypt-at-use.
 * This module imports NOTHING from src/services/byok-custody.ts and never will.
 *
 * THREE OUTCOMES, NEVER TWO (LESSONS 5, CLAUDE_RULES). A refusal is a clean explicit deny. A database
 * or RepID read that ERRORS refuses with `not_checked` (503) — never silently a pass — and the raw
 * error is logged server-side only, never returned. "Not checked" is not "passed".
 *
 * FLAG: the routes reuse SIGNED_JOB_VERIFY_ENABLED (default OFF), so this whole surface lands
 * finished-and-inert until the operator applies the migration AND flips the one flag #1273 already
 * uses. No new env var is introduced.
 */
import { getAddress, id as keccak256Utf8, isAddress } from 'ethers';
import {
  CHAIN_ID,
  canonicalJson,
  verifySignedJob,
  type Policy,
  type VerifyOutcome,
} from './signed-job';
import { verifyWalletMessage, type SignatureChain } from './wallet-signature';
import { db } from '../db';

const HEX = /^0x[0-9a-fA-F]+$/;
const UNIX_INT = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n);
const INT_STRING = (s: unknown): s is string => typeof s === 'string' && /^[0-9]+$/.test(s);

/**
 * The policy hash IS the primary key: keccak256 of the SAME canonical JSON the owner signed. Because
 * canonicalJson sorts keys at every depth, the client and the server derive the identical string from
 * the same policy, so the hash is content-addressed and deterministic. keccak256Utf8 (`ethers.id`) is
 * the exact primitive hashPayee uses, keeping one hashing convention across the TrustKeys surface.
 */
export function computePolicyHash(policy: Policy): string {
  return keccak256Utf8(canonicalJson(policy));
}

// --- Policy registration ------------------------------------------------------

export interface PolicyRegistrationInput {
  policy: unknown;
  signature: unknown;
}

export type PolicyRegistrationOutcome =
  | { ok: true; owner: string; policy_hash: string; policy: Policy }
  | { ok: false; error: 'bad_request' | 'signature_mismatch' | 'expired' | 'not_checked'; message: string };

/** Shape validation up front: a malformed policy is a clean refusal, never a crash or a fake pass. */
function policyShapeError(policy: unknown, signature: unknown): string | null {
  if (!policy || typeof policy !== 'object') return 'policy must be an object';
  if (typeof signature !== 'string' || !HEX.test(signature)) return 'policy_signature must be a hex string';
  const p = policy as Record<string, unknown>;
  if (p['type'] !== 'trustkeys-policy') return 'policy.type must be trustkeys-policy';
  if (typeof p['owner'] !== 'string' || !isAddress(p['owner'])) return 'policy.owner must be an address';
  if (p['chain_id'] !== CHAIN_ID) return `policy.chain_id must be ${CHAIN_ID}`;
  if (!INT_STRING(p['cap'])) return 'policy.cap must be an integer string (token smallest-unit)';
  if (typeof p['token'] !== 'string' || !p['token']) return 'policy.token is required';
  if (!Array.isArray(p['payee_hashes']) || !p['payee_hashes'].every((h) => typeof h === 'string' && HEX.test(h)))
    return 'policy.payee_hashes must be an array of hex hashes';
  if (!UNIX_INT(p['expiry'])) return 'policy.expiry must be a unix-seconds integer';
  if (typeof p['policy_nonce'] !== 'string' || !HEX.test(p['policy_nonce'])) return 'policy.policy_nonce must be a hex string';
  return null;
}

/**
 * Verify a policy REGISTRATION: recover the owner from the policy signature over canonicalJson(policy),
 * confirm it is a trustkeys-policy and not expired, and return the owner + content-addressed hash.
 * The signing order mirrors the inline verifier in signed-job.ts: signature (incl. not_checked) first,
 * then expiry, so an unsigned caller never learns a policy's expiry status.
 *
 * `chain` is injectable only so a test can exercise the smart-wallet not_checked path; the route omits
 * it and the jest offline setup makes every unit address a plain wallet.
 */
export async function verifyPolicyRegistration(
  input: PolicyRegistrationInput,
  chain?: SignatureChain,
): Promise<PolicyRegistrationOutcome> {
  const shape = policyShapeError(input.policy, input.signature);
  if (shape) return { ok: false, error: 'bad_request', message: shape };

  const policy = input.policy as Policy;
  const signature = input.signature as string;

  const check = await verifyWalletMessage(policy.owner, canonicalJson(policy), signature, chain);
  if (!check.ok && check.reason === 'not_checked') {
    return { ok: false, error: 'not_checked', message: 'Could not verify the policy signature against the chain; nothing was recorded.' };
  }
  if (!check.ok) {
    return { ok: false, error: 'signature_mismatch', message: 'The policy signature did not recover to its owner.' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (policy.expiry <= now) {
    return { ok: false, error: 'expired', message: 'The policy has already expired.' };
  }

  return { ok: true, owner: getAddress(policy.owner), policy_hash: computePolicyHash(policy), policy };
}

// --- Revocation ---------------------------------------------------------------

/**
 * The revocation object. Canonicalized the SAME way as a policy/job, so its `type` is inside the
 * signed bytes: a policy or job signature can never be replayed as a revocation, and tampering with
 * any field breaks recovery. This is a NEW signed object, not a change to the policy/job format.
 */
export interface Revocation {
  v: number;
  type: 'trustkeys-policy-revoke';
  owner: string;
  policy_hash: string;
  nonce: string;
  expiry: number;
}

export interface RevocationInput {
  revocation: unknown;
  signature: unknown;
  /** The stored policy's owner. When present, the recovered signer must equal it, else `not_owner`. */
  expectedOwner?: string;
}

export type RevocationOutcome =
  | { ok: true; owner: string; policy_hash: string; nonce: string }
  | { ok: false; error: 'bad_request' | 'signature_mismatch' | 'not_owner' | 'expired' | 'not_checked'; message: string };

function revocationShapeError(revocation: unknown, signature: unknown): string | null {
  if (!revocation || typeof revocation !== 'object') return 'revocation must be an object';
  if (typeof signature !== 'string' || !HEX.test(signature)) return 'revocation_signature must be a hex string';
  const r = revocation as Record<string, unknown>;
  if (r['type'] !== 'trustkeys-policy-revoke') return 'revocation.type must be trustkeys-policy-revoke';
  if (typeof r['owner'] !== 'string' || !isAddress(r['owner'])) return 'revocation.owner must be an address';
  if (typeof r['policy_hash'] !== 'string' || !HEX.test(r['policy_hash'])) return 'revocation.policy_hash must be a hex string';
  if (typeof r['nonce'] !== 'string' || !HEX.test(r['nonce'])) return 'revocation.nonce must be a hex string';
  if (!UNIX_INT(r['expiry'])) return 'revocation.expiry must be a unix-seconds integer';
  return null;
}

/**
 * Verify a REVOCATION: recover the signer over canonicalJson(revocation), require it to be the policy
 * owner, and confirm it has not expired. `expectedOwner` is the stored policy's owner the route looked
 * up; binding the signer to it is what stops anyone but the owner revoking a policy. An EXPIRED
 * revocation is refused too, so the signed `expiry` field is enforced rather than recorded and ignored.
 *
 * Order: signature (incl. not_checked) → owner binding → expiry, so an attacker who signs validly with
 * their OWN key against a victim's policy gets `not_owner`, not a leak of the victim policy's validity.
 */
export async function verifyRevocation(input: RevocationInput, chain?: SignatureChain): Promise<RevocationOutcome> {
  const shape = revocationShapeError(input.revocation, input.signature);
  if (shape) return { ok: false, error: 'bad_request', message: shape };

  const revocation = input.revocation as Revocation;
  const signature = input.signature as string;

  const check = await verifyWalletMessage(revocation.owner, canonicalJson(revocation), signature, chain);
  if (!check.ok && check.reason === 'not_checked') {
    return { ok: false, error: 'not_checked', message: 'Could not verify the revocation signature against the chain; nothing was changed.' };
  }
  if (!check.ok) {
    return { ok: false, error: 'signature_mismatch', message: 'The revocation signature did not recover to its owner.' };
  }

  if (input.expectedOwner && getAddress(revocation.owner) !== getAddress(input.expectedOwner)) {
    return { ok: false, error: 'not_owner', message: 'The revocation signer is not the owner of this policy.' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (revocation.expiry <= now) {
    return { ok: false, error: 'expired', message: 'The revocation has already expired.' };
  }

  return { ok: true, owner: getAddress(revocation.owner), policy_hash: revocation.policy_hash, nonce: revocation.nonce };
}

// --- Verify a job against the owner's ACTIVE stored policy ---------------------

/** VerifyOutcome plus the 404 the stored-policy path needs; shares #1273's refusal body shape. */
type NoActivePolicyOutcome = { status: 404; body: { verified: false; error: 'no_active_policy'; message: string } };
type BadJobOutcome = { status: 400; body: { verified: false; error: 'bad_request'; message: string } };
type DbRefusal = { status: 503; body: { verified: false; error: 'not_checked'; message: string } };
export type StoredPolicyVerifyOutcome = VerifyOutcome | NoActivePolicyOutcome | BadJobOutcome | DbRefusal;

/**
 * Verify a job with NO inline policy, against the owner's active stored policy. "Active" = the most
 * recent row for the owner with revoked_at IS NULL and expiry in the future; a revoked or expired
 * policy simply is not active and yields the same `no_active_policy`.
 *
 * SECURITY: the active policy is looked up by the job's CLAIMED owner, but it is verifySignedJob that
 * binds the job SIGNATURE to that owner (and requires policy.owner === job.owner). So an attacker who
 * names a victim as job.owner cannot borrow the victim's policy — their signature will not recover to
 * the victim and the inline verifier returns signature_mismatch. This path reuses verifySignedJob
 * verbatim, so cap/payee/expiry/replay/receipt behave EXACTLY as the inline path.
 */
export async function verifyJobWithStoredPolicy(
  input: { job: unknown; job_signature: unknown },
  chain?: SignatureChain,
): Promise<StoredPolicyVerifyOutcome> {
  const job = input.job;
  if (!job || typeof job !== 'object') {
    return { status: 400, body: { verified: false, error: 'bad_request', message: 'job must be an object' } };
  }
  const owner = (job as Record<string, unknown>)['owner'];
  if (typeof owner !== 'string' || !isAddress(owner)) {
    return { status: 400, body: { verified: false, error: 'bad_request', message: 'job.owner must be an address' } };
  }

  const now = Math.floor(Date.now() / 1000);
  const lookup = await db
    .from('signed_policies')
    .select('policy_json, signature')
    .ilike('owner', owner.toLowerCase())
    .is('revoked_at', null)
    .gt('expiry', now)
    .order('created_at', { ascending: false })
    .limit(1);

  if (lookup.error) {
    // A DB error REFUSES. Logged server-side only; the raw error never leaves.
    console.error('[signed-policy] active-policy lookup failed', lookup.error);
    return { status: 503, body: { verified: false, error: 'not_checked', message: 'Could not read the owner active policy, so nothing was recorded.' } };
  }

  const rows = (lookup.data as Array<{ policy_json: unknown; signature: string }> | null) ?? [];
  const active = rows[0];
  if (!active) {
    return { status: 404, body: { verified: false, error: 'no_active_policy', message: 'This owner has no active signed policy.' } };
  }

  // Verify EXACTLY as the inline path: hand the stored policy and its stored signature to #1273.
  return verifySignedJob(
    { policy: active.policy_json, policy_signature: active.signature, job: input.job, job_signature: input.job_signature },
    chain,
  );
}
