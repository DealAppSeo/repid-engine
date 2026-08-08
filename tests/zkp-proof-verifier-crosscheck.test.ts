/**
 * ZKP HYGIENE — cross-crate proof verification (audit item #7a).
 *
 * Every other ZKP test in this repo (`zkp-audit-service.test.ts`) MOCKS the WASM
 * verifier — it proves the service's control flow, not that a real proof actually
 * verifies. This test closes that gap: it takes a GENUINE Plonky3 range-check proof
 * produced by the deployed `zkp-postcard` prover (captured from `repid_zkp_proofs`
 * row 79103, committed as a raw binary fixture) and runs it through the REAL
 * `@hyperdag/proof-verifier` WASM. Nothing here is faked.
 *
 * It asserts the two directions the audit asked for:
 *   - an HONEST statement verifies  → verified === true
 *   - a TAMPERED statement does not  → verified === false
 *     (inflated score, and a substituted agent_id — both are cryptographically
 *      bound in the STARK, so the opening argument fails)
 *   - a TAMPERED proof body does not → verified === false (bincode deser fails)
 *
 * It also PINS a real, honest limitation measured on the live verifier: `tier` is
 * NOT bound in the proof, so substituting it still verifies. That is exactly why
 * `zkp-audit-service` derives tier from the score DB-side and never trusts the
 * prover's tier claim — this test makes that property regression-proof.
 *
 * Loader note: we call the package's Node WASM target (`pkg-node`, CommonJS with a
 * synchronous `WebAssembly.Instance`) directly. That is the identical entry point
 * the package's own `verify()` invokes under Node — going through it keeps the test
 * inside jest's CommonJS module loader instead of fighting the ESM/`await import()`
 * wrapper. Same WASM, same code path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Direct require of the package's Node WASM target — see the loader note above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const verifier: { init_panic_hook(): void; verify_proof(inputJson: string): string } =
  require('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js');

interface VerifyResult {
  verified: boolean;
  error: string | null;
  proof_size_bytes: number;
  verifier_version: string;
}

interface Statement {
  agent_id: string;
  tier: string;
  repid_score: number;
  threshold: number;
}

function verify(proofB64: string, statement: Statement): VerifyResult {
  return JSON.parse(
    verifier.verify_proof(JSON.stringify({ proof_bytes: proofB64, statement }))
  ) as VerifyResult;
}

const FIX_DIR = join(__dirname, 'fixtures', 'zkp');
const meta = JSON.parse(
  readFileSync(join(FIX_DIR, 'repid-proof-79103.json'), 'utf8')
) as { statement: Statement; provenance: { proof_bin: string; proof_bytes_len: number } };

const PROOF_BYTES = readFileSync(join(FIX_DIR, meta.provenance.proof_bin));
const PROOF_B64 = PROOF_BYTES.toString('base64');
const HONEST = meta.statement;

beforeAll(() => {
  verifier.init_panic_hook();
});

describe('cross-crate: a real zkp-postcard proof through @hyperdag/proof-verifier', () => {
  it('the fixture is the intact real proof (byte length matches provenance)', () => {
    expect(PROOF_BYTES.length).toBe(meta.provenance.proof_bytes_len);
  });

  it('ACCEPTS the honest statement (verified === true)', () => {
    const r = verify(PROOF_B64, HONEST);
    expect(r.verified).toBe(true);
    expect(r.error).toBeNull();
    expect(r.verifier_version).toBe('0.2.0');
    expect(r.proof_size_bytes).toBe(meta.provenance.proof_bytes_len);
  });

  it('REJECTS an inflated score — the score is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, repid_score: HONEST.repid_score + 7000 });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a substituted agent_id — the subject is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, agent_id: '00000000-0000-0000-0000-000000000000' });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a lowered threshold — the threshold is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, threshold: 1 });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a statement that claims a score below its own threshold (claim check)', () => {
    const r = verify(PROOF_B64, { ...HONEST, repid_score: HONEST.threshold - 1 });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/score <= threshold|claim/i);
  });

  it('REJECTS a tampered proof body (a single flipped byte breaks deserialisation)', () => {
    const tampered = Buffer.from(PROOF_BYTES);
    const i = Math.floor(tampered.length / 2);
    tampered[i] = tampered[i]! ^ 0xff;
    const r = verify(tampered.toString('base64'), HONEST);
    expect(r.verified).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // Honest, measured limitation — pinned so it cannot silently change. `tier` is
  // NOT a bound public input, so substituting it still verifies. This is the reason
  // zkp-audit-service derives tier DB-side and ignores the prover's tier claim.
  it('DOES NOT bind tier: substituting the tier still verifies (documented caveat)', () => {
    const r = verify(PROOF_B64, { ...HONEST, tier: 'VETERAN' });
    expect(r.verified).toBe(true);
  });
});
