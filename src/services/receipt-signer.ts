/**
 * receipt-signer.ts — the SERVICE-KEY signer for ISSUED Trust Receipts (fail-closed).
 *
 * WHAT THIS PROVES. A Trust Receipt issued by src/services/receipt-issuer.ts is, on its own, a row in
 * our database — believing it means trusting a DB read. This module lets the engine attach a DETACHED
 * signature over the receipt's canonical content, signed with the engine's OWN receipt-only key, so a
 * third party can recover the signer from the receipt bytes + signature and confirm it equals the
 * engine's PUBLISHED signer — i.e. "THIS backend produced THIS receipt", without trusting a DB read.
 *
 * THIS IS A RECEIPT-ONLY SERVICE KEY — NOT A USER, PAYMENT, OR CUSTODY KEY.
 *   - It is read ONLY from RECEIPT_SIGNING_KEY (an engine attestation EOA private key, exactly like the
 *     EAS / BASE_SEPOLIA attestor keys this system already uses). This module reads NO other key env —
 *     not any `<AGENT>_PRIVATE_KEY`, not AGENT_KEY_MASTER, not DEPLOYER_PRIVATE_KEY, not ERC8004_*.
 *   - It holds NO user secret and never decrypts one. "No key on our disk" is about USER secrets; this
 *     signs a statement the engine already made (it issued this receipt), not anyone else's key.
 *   - It CANNOT be confused with a payment signer. It signs ONLY a domain-separated receipt object via
 *     EIP-191 personal_sign (prefix `\x19Ethereum Signed Message:\n`). The x402 / payment path signs
 *     EIP-712 typed data (`\x19\x01` + domainSeparator + structHash) with a DIFFERENT key. A personal_
 *     sign over a receipt is structurally invalid as an EIP-712 transfer authorization, so a receipt
 *     signature can never move money. `tests/receipt-signer.test.ts` proves this by construction.
 *
 * FAIL CLOSED — THREE OUTCOMES, NEVER TWO (LESSONS 5, CLAUDE_RULES).
 *   - signReceipt() REFUSES (returns { ok:false }) when the key is unset/unusable. It is the WRITE
 *     path's job to treat that refusal as fatal and NOT persist a receipt that would look issued. A
 *     missing key must never yield a receipt that claims to be signed when it is not.
 *   - verifyReceiptSignature() returns VERIFIED / FAILED / NOT_CHECKED. NOT_CHECKED (no engine signer
 *     configured) is NOT a pass — "we could not check" is never reported as "it verified".
 *
 * THE KEY NEVER LEAVES. The private key appears in no return value, no log line, and no error. The only
 * things surfaced are the PUBLIC signer address and the signature bytes — both non-secret by construction.
 *
 * FLAG. RECEIPT_SIGNING_ENABLED (default OFF), read per-call so it can be flipped (and tested) without a
 * module reload. When OFF the issuer is byte-for-byte unchanged; this module is simply not invoked.
 *
 * BYTE CONTRACT. The signer signs canonicalJson({ v:1, type:RECEIPT_SIGNATURE_TYPE, content_hash }),
 * where content_hash = keccak256(canonicalJson(receipt WITHOUT its detached signature field)). `type`
 * domain-separates a receipt signature from a policy/job/revoke/trustkeys-receipt signature. Signing a
 * hash (not the whole receipt) keeps the signed message small and lets a verifier recompute identical
 * bytes from the stored receipt. canonicalize here is identical to receipt-issuer.ts's, and
 * `tests/receipt-signer.test.ts` pins that the two never drift.
 *
 * KEY ID + ROTATION (2026-10-14, XC1 review of #1374). Every signature block carries `key_id`: the
 * checksummed PUBLIC address of the key that signed it. It is not in the signed bytes and does not need
 * to be: the verifier RECOVERS the signer from the signature and requires key_id to equal it, so a block
 * cannot name a key it was not signed by. Blocks from before key_id verify exactly as before.
 * The verifier accepts the CURRENT key (RECEIPT_SIGNING_KEY's address) plus the RETIRED addresses in
 * RECEIPT_SIGNING_PREVIOUS_ADDRESSES (comma-separated, PUBLIC addresses only: a retired private key is
 * never kept). One malformed entry voids the whole list (logged): fail closed means accepting fewer
 * keys, never guessing. No current key = NOT_CHECKED even with a previous list (a deployment that cannot
 * sign is misconfigured, and it must not keep confirming).
 *
 * ROTATION STEPS (RECEIPT_SIGNING_KEY is Sean-only env):
 *   1. Generate the new key. Note the OLD key's public address (GET the signer, or a recent key_id).
 *   2. In ONE deploy: append the old address to RECEIPT_SIGNING_PREVIOUS_ADDRESSES, then set
 *      RECEIPT_SIGNING_KEY to the new key. Old receipts keep verifying (their key_id is the old address);
 *      new ones are signed by the new key.
 *   3. Keep the old address listed for as long as an old signature must verify: for the kernel gate that
 *      is REPID_CONFIRMED_RECEIPT_TTL_HOURS (default 72h; an older receipt confirms nothing anyway); for an
 *      issued Trust Receipt a third party may check, keep it. Then remove it.
 *   A LISTED PREVIOUS KEY HAS NO NOT-AFTER. It verifies anything it ever signed, including anything signed
 *   with it after it was retired, for as long as it stays listed. So remove it as soon as its receipts
 *   have expired (step 3); the list is a grace period, not an archive.
 *   COMPROMISED KEY: do NOT list its address. Every receipt it signed then FAILS (that is the point); its
 *   unconsumed confirmations are lost, which is the accepted cost.
 *   KNOWN GAP: receipt-attestation.ts (signed-job receipts) reads the same RECEIPT_SIGNING_KEY with its
 *   own loader and has no previous set; rotating breaks its verification of older signed-job receipts.
 *
 * KNOWN GAP — NO DEPLOYMENT ID (documented, not built; XC1 re-attack of #1378). The signed bytes bind
 * the receipt's content, not WHICH deployment indexed it. Another database that trusts the same signer
 * address (a staging copy, a restored backup, a second deployment sharing the key) accepts the same row.
 * The sealed receipt does carry header.env = { network, chain_id, is_simulated }, and nothing checks it
 * against the running deployment today. Checking chain_id against the engine's configured network
 * (and refusing is_simulated receipts in a production deployment) would stop a testnet receipt from
 * confirming on mainnet. It would not tell two deployments on the same chain apart; that needs a
 * per-deployment id inside the signed bytes. Neither is built.
 */
import { Wallet, getAddress, verifyMessage, keccak256, toUtf8Bytes } from 'ethers';

/** Domain-separation tag inside the signed bytes. A receipt signature can never be replayed elsewhere. */
export const RECEIPT_SIGNATURE_TYPE = 'hyperdag.repid.receipt.signature.v1';
/** The signature scheme. EIP-191 personal_sign — NOT EIP-712, so this can never be a payment authorization. */
export const RECEIPT_SIGNATURE_SCHEME = 'eip191-personal-sign' as const;
/** The ONE env var this signer ever reads for key material. Named, never valued. */
export const RECEIPT_SIGNING_KEY_ENV = 'RECEIPT_SIGNING_KEY' as const;
/** The feature flag env var (default OFF). */
export const RECEIPT_SIGNING_ENABLED_ENV = 'RECEIPT_SIGNING_ENABLED' as const;
/** The reserved field on a receipt that carries the detached signature. Excluded from the signed content. */
export const RECEIPT_SIGNATURE_FIELD = 'engine_signature' as const;

/**
 * Read per-call so the flag can be flipped (and tested) without a module reload. Default OFF.
 * The env name is spelled as a literal (not via the constant) so the build-time env registry
 * generator — which scans for literal `process.env['NAME']` reads — discovers it.
 */
export function receiptSigningEnabled(): boolean {
  return process.env['RECEIPT_SIGNING_ENABLED'] === 'true';
}

/**
 * Deterministic canonical JSON: sorted keys at every depth, no whitespace, arrays left in order.
 * IDENTICAL in behaviour to receipt-issuer.ts's `canonicalize` (a consistency test pins that they
 * agree, so the two can never silently diverge); kept local here to avoid a circular import, since
 * receipt-issuer imports THIS module for the write-path wire-in.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

/** Strip the reserved detached-signature field so a receipt hashes identically with or without it attached. */
function withoutSignature(receipt: unknown): unknown {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt as Record<string, unknown>)) {
    if (k !== RECEIPT_SIGNATURE_FIELD) rest[k] = v;
  }
  return rest;
}

/** keccak256 over the canonical bytes of the receipt (minus its detached signature). */
export function receiptContentHash(receipt: unknown): string {
  return keccak256(toUtf8Bytes(canonicalize(withoutSignature(receipt))));
}

/** The small, domain-separated object the engine actually signs. */
function signingObject(contentHash: string): Record<string, unknown> {
  return { v: 1, type: RECEIPT_SIGNATURE_TYPE, content_hash: contentHash };
}

/**
 * Build the engine receipt-signing wallet from RECEIPT_SIGNING_KEY. SEPARATE loader (deliberately not
 * shared with receipt-attestation.ts): this path FAILS CLOSED, and it must read nothing but the
 * receipt key. Returns null when the var is unset/empty (the refuse case) OR present-but-malformed (an
 * operator error, logged as a FIXED message — never the key or the raw error, which could echo key bytes).
 */
function loadReceiptSigningWallet(): Wallet | null {
  // Literal name (not the constant) so the build-time env registry generator discovers it.
  const raw = process.env['RECEIPT_SIGNING_KEY'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new Wallet(raw.trim());
  } catch {
    // Present but unusable. Do NOT log the error object — it can carry the offending key bytes.
    console.error('[receipt-signer] RECEIPT_SIGNING_KEY is set but is not a usable private key; signing refuses.');
    return null;
  }
}

/** The configured engine receipt signer's PUBLIC address, or null when the key is unset/unusable. */
export function receiptSignerAddress(): string | null {
  const wallet = loadReceiptSigningWallet();
  return wallet ? getAddress(wallet.address) : null;
}

/**
 * RETIRED signer addresses that still verify (see KEY ID + ROTATION above). Public data, so the bad entry
 * count may be logged. Any malformed entry (bad shape, bad EIP-55 checksum, or the zero address, which no
 * key signs for) voids the WHOLE list.
 */
export function previousReceiptSignerAddresses(): string[] {
  const raw = process.env['RECEIPT_SIGNING_PREVIOUS_ADDRESSES'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(entry) || /^0x0{40}$/.test(entry)) throw new Error('shape');
      out.push(getAddress(entry));
    } catch {
      console.error('[receipt-signer] RECEIPT_SIGNING_PREVIOUS_ADDRESSES has a malformed entry; ignoring the whole list (only the current key verifies).');
      return [];
    }
  }
  return out;
}

/** The detached signature block attached to a signed receipt. Every field is non-secret. */
export interface ReceiptSignature {
  scheme: typeof RECEIPT_SIGNATURE_SCHEME;
  type: typeof RECEIPT_SIGNATURE_TYPE;
  /** The engine's PUBLIC signer address (checksummed). */
  signer: string;
  /**
   * Which key signed: its checksummed PUBLIC address. The verifier requires it to equal the recovered
   * signer. Optional only so blocks signed before 2026-10-14 still verify.
   */
  key_id?: string;
  /** The detached signature bytes (hex). */
  signature: string;
  /** keccak256 of the canonical receipt (minus this signature) — what the signature commits to. */
  content_hash: string;
  signed_at: string;
}

export type SignReceiptResult =
  | { ok: true; signature: ReceiptSignature }
  | { ok: false; reason: 'no_signing_key' | 'sign_failed'; message: string };

/**
 * Sign a receipt with the engine's receipt-only service key (EIP-191 personal_sign over the canonical
 * signing object binding the receipt's content hash). Returns { ok:true, signature } on success, or a
 * FAIL-CLOSED refusal when the key is unset/unusable or signing throws. NEVER throws, and the key never
 * appears in the return, a log, or an error.
 *
 * `receipt` is the receipt object to sign (its detached signature field, if any, is excluded from the
 * signed content). The signer binds the FULL receipt content — including a content-address id — so a
 * single byte changed anywhere breaks verification.
 */
export async function signReceipt(receipt: unknown): Promise<SignReceiptResult> {
  const wallet = loadReceiptSigningWallet();
  if (!wallet) {
    return {
      ok: false,
      reason: 'no_signing_key',
      message: 'RECEIPT_SIGNING_KEY is unset or unusable; refusing to issue a signed receipt (not checked is not signed).',
    };
  }
  const contentHash = receiptContentHash(receipt);
  try {
    const signature = await wallet.signMessage(canonicalize(signingObject(contentHash)));
    return {
      ok: true,
      signature: {
        scheme: RECEIPT_SIGNATURE_SCHEME,
        type: RECEIPT_SIGNATURE_TYPE,
        signer: getAddress(wallet.address),
        key_id: getAddress(wallet.address),
        signature,
        content_hash: contentHash,
        signed_at: new Date().toISOString(),
      },
    };
  } catch {
    // Signing failed for a reason unrelated to key absence. Fixed message only — no error object (it
    // could reference key material), no key. Still a refusal: the caller must fail closed.
    console.error('[receipt-signer] receipt signing failed; refusing to issue a signed receipt.');
    return { ok: false, reason: 'sign_failed', message: 'the signing key could not sign the receipt; refusing.' };
  }
}

export type VerifyReceiptSignatureResult =
  /** `signer` is the key that signed it; `retired` when that is a RECEIPT_SIGNING_PREVIOUS_ADDRESSES key. */
  | { status: 'VERIFIED'; signer: string; retired: boolean }
  | { status: 'FAILED'; reason: string; signer: string | null }
  | { status: 'NOT_CHECKED'; reason: string };

/** secp256k1 group order n, and n/2: the EIP-2 bound on a canonical (low) s. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/** null when `sig` is a canonical 65-byte EIP-191 signature, else why not. Pure, never throws. */
export function signatureShapeProblem(sig: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return 'signature is not 65 bytes of hex.';
  const v = parseInt(sig.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return 'signature v is not 27 or 28.';
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  if (s === 0n || s > SECP256K1_HALF_N) return 'signature s is zero or high (EIP-2 malleable form).';
  return null;
}

/**
 * Verify a receipt's detached signature. Three outcomes:
 *   VERIFIED    — the content hash matches the receipt AND the signature recovers to the engine signer.
 *   FAILED      — a tampered receipt, a malformed/wrong-domain block, or a signature from another key.
 *   NOT_CHECKED — no engine signer is configured, so we cannot confirm our own signature. NEVER a pass.
 *
 * Pure crypto — no DB, no chain, no throw. The signature may be passed explicitly or read off the
 * receipt's reserved `engine_signature` field.
 */
export function verifyReceiptSignature(
  receipt: unknown,
  signature?: ReceiptSignature | null,
): VerifyReceiptSignatureResult {
  const engine = receiptSignerAddress();
  if (engine === null) {
    return { status: 'NOT_CHECKED', reason: 'no engine signer configured (RECEIPT_SIGNING_KEY unset); cannot confirm the signature.' };
  }

  const block =
    signature ??
    (receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? ((receipt as Record<string, unknown>)[RECEIPT_SIGNATURE_FIELD] as ReceiptSignature | undefined)
      : undefined);

  if (!block || typeof block !== 'object') {
    return { status: 'FAILED', reason: 'no signature block present on the receipt.', signer: engine };
  }
  const b = block as Partial<ReceiptSignature>;
  if (b.type !== RECEIPT_SIGNATURE_TYPE) {
    return { status: 'FAILED', reason: 'signature type is not a receipt signature (domain separation).', signer: engine };
  }
  if (typeof b.signature !== 'string' || typeof b.content_hash !== 'string') {
    return { status: 'FAILED', reason: 'signature block is malformed.', signer: engine };
  }

  // 1. Tamper check: the receipt's actual content must match the hash the signature committed to.
  if (receiptContentHash(receipt) !== b.content_hash) {
    return { status: 'FAILED', reason: 'receipt content does not match the signed content hash (tampered).', signer: engine };
  }

  // 2. The signature's own shape, checked here rather than left to the library: exactly 65 bytes,
  //    v 27/28, and a LOW s (EIP-2). A high-s signature is the same signature malleated: it recovers the
  //    same signer, so accepting it would give one receipt two valid signature strings. ethers 6 throws
  //    on high-s and short input today [V 2026-10-14]; this keeps the rule if the library changes.
  const sigProblem = signatureShapeProblem(b.signature);
  if (sigProblem !== null) {
    return { status: 'FAILED', reason: sigProblem, signer: engine };
  }

  // 3. Recover the signer over the exact domain-separated bytes and confirm it is an engine key: the
  //    current one, or a retired one still listed (KEY ID + ROTATION in the header).
  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(canonicalize(signingObject(b.content_hash)), b.signature));
  } catch {
    return { status: 'FAILED', reason: 'signature did not recover to an address.', signer: engine };
  }
  const retired = recovered !== engine;
  if (retired && !previousReceiptSignerAddresses().includes(recovered)) {
    return { status: 'FAILED', reason: 'signature did not recover to the engine receipt signer.', signer: engine };
  }
  // 4. A key_id, when present, must name the key that actually signed.
  if (b.key_id !== undefined) {
    let named: string | null = null;
    try {
      named = typeof b.key_id === 'string' ? getAddress(b.key_id) : null;
    } catch {
      named = null;
    }
    if (named !== recovered) {
      return { status: 'FAILED', reason: 'key_id does not name the key that signed.', signer: engine };
    }
  }
  return { status: 'VERIFIED', signer: recovered, retired };
}

/**
 * Thrown by the receipt-WRITE path when signing is ENABLED but the signer REFUSES (no/unusable key).
 * Its existence is the fail-closed guarantee: the write throws before any row is persisted, so a
 * receipt that would look issued-but-unsigned is never written. The message carries no key material.
 */
export class ReceiptSigningRequiredError extends Error {
  readonly reason: 'no_signing_key' | 'sign_failed';
  constructor(reason: 'no_signing_key' | 'sign_failed', message: string) {
    super(`receipt signing is enabled but refused (${reason}): ${message} No receipt was written.`);
    this.name = 'ReceiptSigningRequiredError';
    this.reason = reason;
  }
}
