/**
 * receipt-attestation.ts — the ENGINE's own attestation over a verified signed-job receipt.
 *
 * WHAT THIS TURNS A RECEIPT INTO. The signed-job verifier (src/services/signed-job.ts) records ONLY
 * receipt fields. On its own, a receipt is "our DB row": believing it means trusting a database read.
 * This module lets the engine SIGN that row with its own key, so anyone can recover the engine's
 * address from the receipt bytes + signature and confirm it equals the engine's PUBLISHED signer —
 * proving the engine attested a verified job, WITHOUT trusting a DB read.
 *
 * THIS IS THE ENGINE'S KEY, NOT A USER OR CUSTODY KEY. RECEIPT_SIGNING_KEY is an engine attestation
 * EOA private key, exactly like the EAS / BASE_SEPOLIA attestor keys this system already uses. It is
 * NOT a BYOK/user key and NOT a decryptable secret handed to us — "no key on our disk" is about USER
 * secrets, which this never touches. The engine signs a statement it already made (this receipt was
 * verified); it does not hold, decrypt, or act on anyone else's key.
 *
 * INERT WHEN UNSET (THREE OUTCOMES, NEVER TWO — LESSONS 5). With RECEIPT_SIGNING_KEY unset the whole
 * feature is off: signReceipt returns null (NEVER throws on absence), engineSignerAddress returns
 * null, and a verify over any signature is `verified:false` because there is no signer to match.
 * Receipts are then written UNSIGNED and labelled `attested:false` — never presented as attested.
 * A missing key is "not attested", which is not "attestation failed" and is never "attested".
 *
 * THE KEY NEVER LEAVES. The private key appears in no return value, no log line, and no error. The
 * only things this module ever surfaces are the PUBLIC signer address and the signature bytes — both
 * non-secret by construction (a signature and a public address reveal nothing about the key).
 *
 * BYTE CONTRACT. The signed object is canonicalJson({ v:1, type:'trustkeys-receipt', ...fields }),
 * reusing the ONE canonicalizer in signed-job.ts so the bytes are deterministic. `type` domain-
 * separates a receipt attestation from a policy/job/revoke signature. `time` is the EXACT timestamp
 * stored on the row, so a later verify over the stored fields recomputes identical bytes.
 */
import { Wallet, getAddress, verifyMessage } from 'ethers';
import { canonicalJson } from './signed-job';

/** The exact field set an engine attestation covers. `owner` is the lowercased wallet stored on the row. */
export interface ReceiptFields {
  owner: string;
  nonce: string;
  action: string;
  cap: string;
  payee_hash: string;
  chain_id: number;
  time: string;
}

/** What signReceipt returns on the success path; both halves are non-secret (public address + signature). */
export interface ReceiptAttestation {
  signature: string;
  signer: string;
}

export interface ReceiptVerification {
  verified: boolean;
  engine_signer: string | null;
}

/**
 * The canonical object the engine signs. canonicalJson sorts keys at every depth, so this field order
 * is cosmetic — but the field SET is the contract. `owner` is lowercased here so engine sign and
 * verify agree regardless of the caller's casing, matching the lowercased owner stored on the row.
 */
function receiptSigningObject(fields: ReceiptFields): Record<string, unknown> {
  return {
    v: 1,
    type: 'trustkeys-receipt',
    owner: fields.owner.toLowerCase(),
    nonce: fields.nonce,
    action: fields.action,
    cap: fields.cap,
    payee_hash: fields.payee_hash,
    chain_id: fields.chain_id,
    time: fields.time,
  };
}

/**
 * Build the engine wallet from RECEIPT_SIGNING_KEY. Returns null when the var is unset/empty (the
 * normal inert state — no log) OR when it is present but malformed (an operator error — logged
 * server-side as a FIXED message, never the key or the raw error, which could echo key bytes).
 */
function loadEngineWallet(): Wallet | null {
  const raw = process.env['RECEIPT_SIGNING_KEY'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new Wallet(raw.trim());
  } catch {
    // Present but unusable. Do NOT log the error object — it can carry the offending key bytes.
    console.error('[receipt-attestation] RECEIPT_SIGNING_KEY is set but is not a usable private key; receipts will be written unsigned.');
    return null;
  }
}

/** The configured engine signer's PUBLIC address, or null when the key is unset/unusable. */
export function engineSignerAddress(): string | null {
  const wallet = loadEngineWallet();
  return wallet ? getAddress(wallet.address) : null;
}

/**
 * Sign a receipt with the engine attestation key (EIP-191 personal_sign over the canonical JSON).
 * Returns { signature, signer } on success, or null when the key is unset/unusable or signing fails.
 * NEVER throws — a signing failure must not fail a verify that already succeeded; the caller stores
 * nulls instead. The key never appears in the return, a log, or an error.
 */
export async function signReceipt(fields: ReceiptFields): Promise<ReceiptAttestation | null> {
  const wallet = loadEngineWallet();
  if (!wallet) return null;
  try {
    const signature = await wallet.signMessage(canonicalJson(receiptSigningObject(fields)));
    return { signature, signer: getAddress(wallet.address) };
  } catch {
    // Signing failed for a reason unrelated to the key being absent. Fixed message only — no error
    // object (it could reference key material), no key.
    console.error('[receipt-attestation] receipt signing failed; the receipt will be stored unsigned.');
    return null;
  }
}

/**
 * Recover the signer over the receipt's canonical bytes and report whether it is the engine signer.
 * Pure crypto — no DB, no chain, no throw: a malformed/incorrect signature recovers to a different
 * address (or fails recovery), both of which are `verified:false`, never a crash or a 503. When the
 * engine has no signer configured, `verified` is false (we cannot confirm our own attestation) and
 * `engine_signer` is null — honest, never a false pass.
 */
export function verifyReceiptAttestation(fields: ReceiptFields, signature: string): ReceiptVerification {
  const engine = engineSignerAddress();
  if (engine === null) return { verified: false, engine_signer: null };
  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(canonicalJson(receiptSigningObject(fields)), signature));
  } catch {
    // Not a recoverable signature over these bytes — a clean "did not verify", not an error.
    return { verified: false, engine_signer: engine };
  }
  return { verified: recovered === engine, engine_signer: engine };
}
