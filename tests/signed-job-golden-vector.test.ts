/**
 * signed-job-golden-vector.test.ts — the CROSS-REPO contract pin for TrustKeys reference tier.
 *
 * WHY THIS FILE EXISTS. The signer lives in another repo (DealAppSeo/trustshell, PR #498) and the
 * verifier lives here (src/services/signed-job.ts). The contract between them is a byte-exact one:
 * the client signs the canonical JSON of a policy and a job, and this engine must recompute the SAME
 * canonical string and recover the SAME signer — a single stray space, a reordered key, or a changed
 * keccak domain in canonicalJson/hashPayee breaks every signature silently. Nothing in either repo
 * fails loudly when that drift happens; the symptom is "every legitimate job suddenly 401s".
 *
 * So this test PINS one golden vector produced by the trustshell client signer and asserts the
 * verifier's OWN code reproduces and accepts it. It imports the real canonicalJson + hashPayee from
 * src/services/signed-job and uses ethers verifyMessage against the real recovered address. If a
 * future change to canonicalJson or hashPayee drifts from the signer, THIS test goes red in CI — the
 * drift can no longer reach production as a quiet 401 storm.
 *
 * THE FIXTURE KEY IS THE PUBLIC HARDHAT ACCOUNT #0. Address 0xf39Fd6e5…92266 is the universally
 * published test account (private key 0xac09…ff80) shipped with Hardhat/Anvil. Its value is ZERO,
 * it is a fixture used in thousands of public test suites, and it is NEVER a real key. The vector was
 * cross-checked against the verifier's real code before it was pinned (so this test passes as written).
 *
 * No DB is touched: canonicalJson and hashPayee are pure. src/db is mocked only so importing the
 * module does not require a live config/boot.
 */

jest.mock('../src/db', () => ({ db: {} }));

import { verifyMessage } from 'ethers';
import { canonicalJson, hashPayee } from '../src/services/signed-job';

// --- The golden vector, verbatim from the trustshell client signer (PR #498) -----------------------
// Hardhat public account #0 — a zero-value, world-published fixture, never a real key.
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const policyObj = {
  v: 1,
  type: 'trustkeys-policy',
  owner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  chain_id: 84532,
  cap: '1000000000',
  token: 'USDC',
  payee_hashes: ['0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515'],
  expiry: 1893456000,
  policy_nonce: '0xabababababababababababababababab',
};

const jobObj = {
  v: 1,
  type: 'trustkeys-job',
  owner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  chain_id: 84532,
  action: 'spend',
  cap: '1000000',
  payee_hash: '0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515',
  expiry: 1893456000,
  nonce: '0x00000000000000000000000000000001',
};

const policyCanon =
  '{"cap":"1000000000","chain_id":84532,"expiry":1893456000,"owner":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","payee_hashes":["0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515"],"policy_nonce":"0xabababababababababababababababab","token":"USDC","type":"trustkeys-policy","v":1}';

const jobCanon =
  '{"action":"spend","cap":"1000000","chain_id":84532,"expiry":1893456000,"nonce":"0x00000000000000000000000000000001","owner":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","payee_hash":"0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515","type":"trustkeys-job","v":1}';

const policySig =
  '0x8c96c6cebc1c23d6caa317dc886978a5a932d6e43ec7196a4dd955c23193037262d5905832b0370efd383673774effabc76b9a3a58e586d3161cbf8a41aa76921c';

const jobSig =
  '0x12355cef8aa1a5676b0522639d8697fb5652c8bf16aab74113503ea421529bce6aad589d394a2ab6e6fe58da1ed61beca05b3c9dc2f33551b7b3e20b405620571b';

const EXPECTED_PAYEE_HASH = '0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515';

describe('TrustKeys signed-job golden vector — the signer↔verifier contract pin', () => {
  it('canonicalJson(policy) reproduces the signer canonical string byte-for-byte', () => {
    expect(canonicalJson(policyObj)).toBe(policyCanon);
  });

  it('canonicalJson(job) reproduces the signer canonical string byte-for-byte', () => {
    expect(canonicalJson(jobObj)).toBe(jobCanon);
  });

  it('hashPayee(payee) reproduces the signer payee hash', () => {
    expect(hashPayee('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(EXPECTED_PAYEE_HASH);
  });

  it('the policy signature recovers to the signer address', () => {
    expect(verifyMessage(policyCanon, policySig).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('the job signature recovers to the SAME signer address', () => {
    expect(verifyMessage(jobCanon, jobSig).toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('the two signatures recover to one and the same owner (policy owner === job owner)', () => {
    const fromPolicy = verifyMessage(policyCanon, policySig).toLowerCase();
    const fromJob = verifyMessage(jobCanon, jobSig).toLowerCase();
    expect(fromPolicy).toBe(fromJob);
    expect(fromPolicy).toBe(policyObj.owner);
    expect(fromPolicy).toBe(jobObj.owner);
  });
});
