/**
 * Sprint R-C Track B Phase B2 — RepID attestation signing and verification.
 *
 * ed25519 sign / verify using Node's built-in `crypto` (no new dependency).
 * The signing key is loaded from `process.env.SIGNING_KEY_DEV` (PKCS#8 PEM).
 * If unset, an ephemeral keypair is generated at module load with a
 * loud warning — production deployments MUST supply a key.
 *
 * The attestation payload is a deterministic-canonical-JSON serialization
 * of {agent_id, repid_score, timestamp_iso, version}. The `version` field
 * lets future migrations rotate signature schemes without invalidating
 * historical attestations.
 *
 * Signature is base64-url. Pubkey is base64 raw 32-byte ed25519 public key.
 *
 * The seam: `verifyRepIDAttestation()` is the abstract trust boundary.
 * A future ZKP layer replaces the `crypto.verify` call with a verifier
 * that takes the same payload+signature shape but checks a zero-knowledge
 * proof instead — `verifyRepIDAttestation` is the only call site any
 * downstream consumer needs to swap.
 */
import * as crypto from 'crypto';

export const ATTESTATION_VERSION = 'repid-attestation/1';

export interface RepIDAttestationInput {
  agent_id: string;
  repid_score: number;
  timestamp_iso: string;
}

export interface RepIDAttestationPayload extends RepIDAttestationInput {
  version: string;
}

export interface RepIDAttestation {
  payload: RepIDAttestationPayload;
  /** Base64-URL-encoded ed25519 signature (64 bytes raw). */
  signature: string;
  /** Base64 raw ed25519 public key (32 bytes). */
  signing_pubkey: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  payload?: RepIDAttestationPayload;
}

/* ------------------------- Key management --------------------------- */

interface KeyMaterial {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  /** Raw 32-byte public key, base64-encoded for inclusion in attestation. */
  publicKeyB64: string;
  ephemeral: boolean;
}

let cachedKey: KeyMaterial | null = null;

function loadOrGenerateSigningKey(): KeyMaterial {
  if (cachedKey) return cachedKey;

  const envKey = process.env.SIGNING_KEY_DEV;
  if (envKey && envKey.trim().length > 0) {
    try {
      const privateKey = crypto.createPrivateKey({
        key: envKey,
        format: 'pem',
      });
      const publicKey = crypto.createPublicKey(privateKey);
      const publicKeyB64 = exportRawPublicKeyB64(publicKey);
      cachedKey = {
        privateKey,
        publicKey,
        publicKeyB64,
        ephemeral: false,
      };
      return cachedKey;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[repid-attestation] SIGNING_KEY_DEV failed to parse: ${msg}. ` +
        `Falling back to ephemeral keypair.`,
      );
    }
  }

  console.warn(
    '[repid-attestation] WARNING: no SIGNING_KEY_DEV in env. ' +
    'Generating EPHEMERAL ed25519 keypair at module load. ' +
    'Attestations will not be verifiable across process restarts. ' +
    'Production deployments MUST set SIGNING_KEY_DEV (PKCS#8 PEM).',
  );

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = exportRawPublicKeyB64(publicKey);
  cachedKey = { privateKey, publicKey, publicKeyB64, ephemeral: true };
  return cachedKey;
}

function exportRawPublicKeyB64(publicKey: crypto.KeyObject): string {
  // Export DER-encoded SPKI, then strip the prefix to get the raw 32-byte
  // ed25519 public key. SPKI for ed25519 is 44 bytes; the last 32 are the key.
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (der.length < 32) {
    throw new Error(`unexpected ed25519 SPKI length: ${der.length}`);
  }
  const raw = der.subarray(der.length - 32);
  return raw.toString('base64');
}

/**
 * Recover a public KeyObject from a base64-encoded raw 32-byte ed25519 key.
 * Used when verifying an attestation whose `signing_pubkey` field is the
 * raw key (the `signRepIDAttestation` output format).
 */
function publicKeyFromRawB64(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`expected 32-byte raw ed25519 pubkey, got ${raw.length}`);
  }
  // Wrap in the SPKI prefix expected by Node's createPublicKey.
  // ed25519 SPKI prefix: 30 2A 30 05 06 03 2B 65 70 03 21 00 (12 bytes)
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/* ----------------------- Canonical serialization -------------------- */

/**
 * Deterministic JSON serialization for signing.
 *
 * Sorts keys alphabetically. ed25519-sign + verify both run on this exact
 * byte sequence — any drift between sign and verify breaks the signature.
 */
function canonicalize(payload: RepIDAttestationPayload): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) {
    sorted[k] = (payload as any)[k];
  }
  return Buffer.from(JSON.stringify(sorted), 'utf-8');
}

/* ------------------------- Public API ------------------------------ */

/**
 * Sign a RepID attestation.
 */
export async function signRepIDAttestation(
  input: RepIDAttestationInput,
): Promise<RepIDAttestation> {
  if (!input.agent_id || typeof input.agent_id !== 'string') {
    throw new Error('agent_id required');
  }
  if (typeof input.repid_score !== 'number' || !Number.isFinite(input.repid_score)) {
    throw new Error('repid_score must be a finite number');
  }
  if (!input.timestamp_iso || typeof input.timestamp_iso !== 'string') {
    throw new Error('timestamp_iso required');
  }

  const payload: RepIDAttestationPayload = {
    agent_id: input.agent_id,
    repid_score: input.repid_score,
    timestamp_iso: input.timestamp_iso,
    version: ATTESTATION_VERSION,
  };

  const km = loadOrGenerateSigningKey();
  const message = canonicalize(payload);
  const sig = crypto.sign(null, message, km.privateKey);

  return {
    payload,
    signature: sig.toString('base64url'),
    signing_pubkey: km.publicKeyB64,
  };
}

/**
 * Verify a RepID attestation.
 *
 * Returns `{valid: false, reason}` instead of throwing — verification
 * is a routine boundary check that callers handle.
 */
export function verifyRepIDAttestation(
  attestation: Partial<RepIDAttestation>,
): VerifyResult {
  if (!attestation || typeof attestation !== 'object') {
    return { valid: false, reason: 'attestation must be an object' };
  }
  const { payload, signature, signing_pubkey } = attestation;
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'payload missing' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return { valid: false, reason: 'signature missing' };
  }
  if (typeof signing_pubkey !== 'string' || signing_pubkey.length === 0) {
    return { valid: false, reason: 'signing_pubkey missing' };
  }
  if (payload.version !== ATTESTATION_VERSION) {
    return { valid: false, reason: `unsupported version: ${payload.version}` };
  }

  const km = loadOrGenerateSigningKey();
  if (signing_pubkey.trim() !== km.publicKeyB64) {
    return { valid: false, reason: 'signing_pubkey does not match authoritative signing key' };
  }

  let pubKey: crypto.KeyObject;
  try {
    pubKey = publicKeyFromRawB64(signing_pubkey);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `pubkey parse failed: ${msg}` };
  }

  let message: Buffer;
  try {
    message = canonicalize(payload as RepIDAttestationPayload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `payload canonicalize failed: ${msg}` };
  }

  let sig: Buffer;
  try {
    sig = Buffer.from(signature, 'base64url');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `signature decode failed: ${msg}` };
  }

  let ok: boolean;
  try {
    ok = crypto.verify(null, message, pubKey, sig);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `verify error: ${msg}` };
  }

  if (!ok) return { valid: false, reason: 'signature does not match payload' };
  return { valid: true, payload: payload as RepIDAttestationPayload };
}

/**
 * Test helper — exposes the signing public key for assertions and
 * lets tests reset the cached key between cases. Not exported via
 * `index.ts` for production callers.
 */
export function _testHelpers() {
  return {
    getCachedPubKeyB64: () => loadOrGenerateSigningKey().publicKeyB64,
    isEphemeral: () => loadOrGenerateSigningKey().ephemeral,
    resetCache: () => {
      cachedKey = null;
    },
  };
}
