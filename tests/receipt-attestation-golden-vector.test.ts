/**
 * receipt-attestation-golden-vector.test.ts — the canonical-bytes pin for the engine receipt attestation.
 *
 * WHY THIS FILE EXISTS. The engine's receipt attestation is a byte-exact contract: any change to
 * canonicalJson (a stray space, a reordered key) or to the receiptSigningObject field set silently
 * breaks every previously-issued signature. The existing receipt-attestation.test.ts uses a random
 * Wallet.createRandom() key — it catches logic bugs but NOT byte drift, because the canonical string
 * is never compared against an external reference.
 *
 * This file PINS the exact canonical string the engine produces for a fixed receipt and asserts that
 * the engine's verifyReceiptAttestation accepts a pre-computed signature over those bytes. If a future
 * change to canonicalJson or receiptSigningObject drifts from this vector, the test goes red in CI —
 * the drift cannot reach production as a quiet "attestation always fails" regression.
 *
 * THE FIXTURE KEY IS THE PUBLIC HARDHAT ACCOUNT #0. Private key 0xac09…ff80, address
 * 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 — a zero-value, world-published fixture shipped with
 * Hardhat/Anvil, used in thousands of public test suites. NEVER a real key. The vector was computed
 * from the actual canonicalJson + ethers.signMessage and then pinned (the test passes as written).
 *
 * The `type:'trustkeys-receipt'` domain separator is the key invariant: a receipt signature must not
 * verify under the policy or job domain, and vice versa. The field set (v, type, owner, nonce, action,
 * cap, payee_hash, chain_id, time) is the published contract for anyone building a verifier.
 *
 * No DB is touched: canonicalJson and receiptSigningObject are pure.
 */

jest.mock('../src/db', () => ({ db: {} }));

const KEY_NAME = 'RECEIPT_SIGNING_KEY' as const;
const SAVED = process.env[KEY_NAME];
afterAll(() => {
  if (SAVED === undefined) delete process.env[KEY_NAME];
  else process.env[KEY_NAME] = SAVED;
});
// We must boot config so receipt-attestation.ts loads; it does NOT call config's throw path.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'http://localhost:54321';
if (!process.env.SUPABASE_SECRET_KEY) process.env.SUPABASE_SECRET_KEY = 'dummy';

import { verifyMessage } from 'ethers';
import { canonicalJson } from '../src/services/signed-job';
import { verifyReceiptAttestation, type ReceiptFields } from '../src/services/receipt-attestation';

// --- The Hardhat #0 engine fixture ----------------------------------------------------------------
// Private key 0xac09…ff80: zero-value, world-published test fixture, never a real key.
const ENGINE_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ENGINE_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // checksummed

// --- The fixed receipt fields --------------------------------------------------------------------
// owner is the lowercased Hardhat #0 address — the engine lowercases before signing, so the golden
// vector exercises that path. payee_hash reuses the value from signed-job-golden-vector.test.ts.
const FIELDS: ReceiptFields = {
  owner:      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  nonce:      '0x00000000000000000000000000000001',
  action:     'spend',
  cap:        '1000000',
  payee_hash: '0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515',
  chain_id:   84532,
  time:       '2026-10-09T00:00:00.000Z',
};

// --- The pinned canonical string (keys alphabetical, numbers not quoted) -------------------------
// Computed from canonicalJson({ v:1, type:'trustkeys-receipt', ...FIELDS }) — the exact bytes the
// engine signs. This is the contract; a drift here means a drift in the attestation wire format.
const RECEIPT_CANON =
  '{"action":"spend","cap":"1000000","chain_id":84532,"nonce":"0x00000000000000000000000000000001","owner":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","payee_hash":"0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515","time":"2026-10-09T00:00:00.000Z","type":"trustkeys-receipt","v":1}';

// --- The pre-computed signature (Hardhat #0 over RECEIPT_CANON via EIP-191 personal_sign) -------
const RECEIPT_SIG =
  '0x14d8f5b140fe25ec8140e1da00e2993c0913aeeef84b9255944c2779768006a266a37b71395eafebd38d050de3d7e600d2fd2db9f32c14b07f651660c4924db11b';

describe('TrustKeys receipt-attestation golden vector — the engine canonical-bytes pin', () => {

  it('canonicalJson over the receipt signing-object reproduces the pinned canonical string byte-for-byte', () => {
    const obj = {
      v: 1,
      type: 'trustkeys-receipt',
      owner: FIELDS.owner,    // already lowercased — the engine lowercases before canonicalizing
      nonce: FIELDS.nonce,
      action: FIELDS.action,
      cap: FIELDS.cap,
      payee_hash: FIELDS.payee_hash,
      chain_id: FIELDS.chain_id,
      time: FIELDS.time,
    };
    expect(canonicalJson(obj)).toBe(RECEIPT_CANON);
  });

  it('the pre-computed signature recovers to the Hardhat #0 engine address', () => {
    expect(verifyMessage(RECEIPT_CANON, RECEIPT_SIG).toLowerCase()).toBe(ENGINE_ADDR.toLowerCase());
  });

  it('verifyReceiptAttestation accepts the pre-computed signature when the engine key is set', () => {
    process.env[KEY_NAME] = ENGINE_KEY;
    const result = verifyReceiptAttestation(FIELDS, RECEIPT_SIG);
    expect(result).toEqual({ verified: true, engine_signer: ENGINE_ADDR });
  });

  it('the receipt domain does NOT verify under a policy or job canonical string (domain isolation)', () => {
    // Use the same RECEIPT_SIG but verify it against the policy/job canonical strings from
    // signed-job-golden-vector.test.ts. Each should recover a DIFFERENT address (the engine key
    // signed a receipt-domain string; verifying the same bytes as a policy-domain string recovers a
    // different, unrelated address — the domain separator is doing its job).
    const policyCanon =
      '{"cap":"1000000000","chain_id":84532,"expiry":1893456000,"owner":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","payee_hashes":["0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515"],"policy_nonce":"0xabababababababababababababababab","token":"USDC","type":"trustkeys-policy","v":1}';
    const jobCanon =
      '{"action":"spend","cap":"1000000","chain_id":84532,"expiry":1893456000,"nonce":"0x00000000000000000000000000000001","owner":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","payee_hash":"0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515","type":"trustkeys-job","v":1}';
    const engineAddrLower = ENGINE_ADDR.toLowerCase();
    // The receipt sig over a policy/job string recovers a random unrelated address — never the engine.
    expect(verifyMessage(policyCanon, RECEIPT_SIG).toLowerCase()).not.toBe(engineAddrLower);
    expect(verifyMessage(jobCanon,    RECEIPT_SIG).toLowerCase()).not.toBe(engineAddrLower);
  });

  it('a tampered field → verifyReceiptAttestation returns verified:false (immutability)', () => {
    process.env[KEY_NAME] = ENGINE_KEY;
    const tampered = { ...FIELDS, cap: '9999' };
    expect(verifyReceiptAttestation(tampered, RECEIPT_SIG).verified).toBe(false);
  });
});
