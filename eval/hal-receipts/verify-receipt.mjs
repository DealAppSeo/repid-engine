#!/usr/bin/env node
// Standalone HAL receipt check. Needs only the receipt, the signer's public key, and Node's crypto.
// It imports NOTHING from this repo on purpose: canonical JSON and the signed message are rebuilt
// here from the spec, so a bug in src/hal/signed-verdict-receipt.ts cannot vouch for itself.
//
//   node eval/hal-receipts/verify-receipt.mjs <receipt.json> <0x + 64 hex public key> [claim.txt]
//
// receipt.json may be the receipt itself or a HAL response carrying `signed_receipt`.
// Prints one JSON line. Exit 0 = verified, 1 = not verified, 2 = bad usage.
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';

const DOMAIN = 'hyperdag.hal-receipt.signature.v1\n';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
};

export function verifyReceipt(r, pubHex, claimText) {
  if (!r || r.v !== 'hal-signed-receipt-v1') return { verified: false, reason: 'malformed' };
  const { receipt_id, signer, signature, ...body } = r;
  if (receipt_id !== 'halr1_' + sha256(canon(JSON.parse(JSON.stringify(body))))) return { verified: false, reason: 'receipt_id_mismatch' };
  if (!Number.isInteger(r.claim_chars_judged) || r.claim_chars_judged < 0 || typeof r.served_from_cache !== 'boolean') return { verified: false, reason: 'malformed' };
  if (!signer || typeof signature !== 'string' || !/^0x[0-9a-f]{128}$/i.test(signature)) return { verified: false, reason: 'unsigned' };
  if (String(signer.public_key).toLowerCase() !== pubHex.toLowerCase()) return { verified: false, reason: 'untrusted_signer' };
  const raw = Buffer.from(pubHex.slice(2), 'hex');
  if (String(signer.fingerprint).toLowerCase() !== '0x' + createHash('sha256').update(raw).digest('hex')) return { verified: false, reason: 'malformed' };
  const { signature: _s, ...signed } = r;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  const ok = verify(null, Buffer.from(DOMAIN + canon(JSON.parse(JSON.stringify(signed))), 'utf8'), key, Buffer.from(signature.slice(2), 'hex'));
  if (!ok) return { verified: false, reason: 'bad_signature' };
  if (claimText !== undefined && (sha256(claimText) !== r.claim_sha256 || sha256(claimText.slice(0, r.claim_chars_judged)) !== r.claim_judged_sha256)) return { verified: false, reason: 'claim_mismatch' };
  // claim_chars_judged: text past this many characters was NOT judged. served_from_cache: the verdict
  // may be for a variant of the claim differing in case or surrounding whitespace.
  return { verified: true, receipt_id, verdict: r.verdict, reason: r.reason, claim_chars_judged: r.claim_chars_judged, served_from_cache: r.served_from_cache };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [file, pub, claimFile] = process.argv.slice(2);
  if (!file || !/^0x[0-9a-fA-F]{64}$/.test(pub ?? '')) {
    console.error('usage: verify-receipt.mjs <receipt.json> <0x + 64 hex public key> [claim.txt]');
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const out = verifyReceipt(doc.signed_receipt ?? doc, pub, claimFile ? readFileSync(claimFile, 'utf8') : undefined);
  console.log(JSON.stringify(out));
  process.exit(out.verified ? 0 : 1);
}
