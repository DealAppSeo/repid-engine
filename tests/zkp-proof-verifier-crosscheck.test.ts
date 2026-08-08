/**
 * ZKP HYGIENE — cross-crate proof verification against @hyperdag/proof-verifier (audit #7a),
 * SYNTHETIC re-do of PR #376.
 *
 * WHAT THIS CLOSES
 * ----------------
 * Every other ZKP test in this repo (`zkp-audit-service.test.ts`) MOCKS the WASM verifier —
 * it exercises the service's control flow, not the fact that a real proof actually verifies.
 * This test runs a GENUINE Plonky3 range-check proof through the REAL `@hyperdag/proof-verifier`
 * WASM and asserts the accept/reject matrix directly. Nothing here is mocked on the honest path.
 *
 * WHY THE PROOF IS SYNTHETIC (the #376 fence)
 * ------------------------------------------
 * PR #376 did this with a proof lifted straight out of the production `repid_zkp_proofs` table —
 * a real proof, a real agent UUID, a real score — committed into this PUBLIC repo. That is a
 * production extract wearing a fixture's clothes, and it cannot be withdrawn. The permanent #376
 * fence (`scripts/hooks/prod-fixture-guard.js`) now blocks that shape.
 *
 * The proof here is instead GENERATED OFFLINE by the @hyperdag/proof-verifier crate's own
 * range-check prover over a fabricated witness (a NIL-variant agent UUID, a made-up score). It is
 * a real STARK proof over inputs that never existed in production. See
 * `scripts/zkp/gen-synthetic-rangecheck-proof.rs` for the exact recipe and
 * `tests/fixtures/zkp/leaf-rangecheck.synthetic.json` for the statement.
 *
 * Loader note: we call the package's Node WASM target (`pkg-node`, CommonJS with a synchronous
 * `WebAssembly.Instance`) directly — the identical entry point the package's own `verify()` uses
 * under Node, kept inside jest's CommonJS loader rather than fighting the ESM `await import()`
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

/** Call the real WASM verify entrypoint. */
function verify(proofB64: string, statement: Statement): VerifyResult {
  return JSON.parse(
    verifier.verify_proof(JSON.stringify({ proof_bytes: proofB64, statement }))
  ) as VerifyResult;
}

/**
 * Fail-closed consumer boundary, mirroring `createWasmVerifier` in
 * `src/services/handlers/zkp-audit-handler.ts`: any throw (verifier unavailable / WASM failed to
 * load) or any non-`{verified:boolean}` shape resolves to `verified:false`. A ZK verifier that
 * cannot run must NEVER read as "verified" — the dangerous default is the silent true.
 */
function verifyFailClosed(
  verifyImpl: (proofB64: string, s: Statement) => unknown,
  proofB64: string,
  statement: Statement
): VerifyResult {
  const fail = (error: string): VerifyResult => ({
    verified: false,
    error,
    proof_size_bytes: 0,
    verifier_version: 'unknown',
  });
  let raw: unknown;
  try {
    raw = verifyImpl(proofB64, statement);
  } catch (e) {
    return fail(`verifier unavailable: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as VerifyResult).verified !== 'boolean') {
    return fail('verifier returned an unexpected shape');
  }
  return raw as VerifyResult;
}

const FIX_DIR = join(__dirname, 'fixtures', 'zkp');
const meta = JSON.parse(
  readFileSync(join(FIX_DIR, 'leaf-rangecheck.synthetic.json'), 'utf8')
) as { SYNTHETIC: boolean; statement: Statement; proof_file: string; proof_bytes_len: number };

const PROOF_BYTES = readFileSync(join(FIX_DIR, meta.proof_file));
const PROOF_B64 = PROOF_BYTES.toString('base64');
const HONEST = meta.statement;

beforeAll(() => {
  verifier.init_panic_hook();
});

describe('cross-crate: a SYNTHETIC range-check proof through @hyperdag/proof-verifier', () => {
  it('the fixture is declared synthetic and intact (byte length matches metadata)', () => {
    expect(meta.SYNTHETIC).toBe(true);
    expect(PROOF_BYTES.length).toBe(meta.proof_bytes_len);
    // Sanity: a NIL-variant synthetic agent id, never a real one.
    expect(HONEST.agent_id).toBe('00000000-0000-4000-8000-0000000000aa');
  });

  it('ACCEPTS the honest statement (verified === true)', () => {
    const r = verify(PROOF_B64, HONEST);
    expect(r.verified).toBe(true);
    expect(r.error).toBeNull();
    expect(r.verifier_version).toBe('0.2.0');
    expect(r.proof_size_bytes).toBe(meta.proof_bytes_len);
  });

  it('REJECTS an inflated score — the score is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, repid_score: HONEST.repid_score + 7000 });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a substituted agent_id — the subject is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, agent_id: '00000000-0000-4000-8000-0000000000bb' });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a lowered threshold — the threshold is bound in the STARK', () => {
    const r = verify(PROOF_B64, { ...HONEST, threshold: 1 });
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/InvalidOpeningArgument|InvalidPowWitness/);
  });

  it('REJECTS a statement that claims a score at/below its own threshold (claim check)', () => {
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

  // Honest, measured limitation — pinned so it cannot silently change. `tier` is NOT a bound
  // public input, so substituting it still verifies. This is exactly why `zkp-audit-service`
  // derives tier DB-side and never trusts the prover's tier claim.
  it('DOES NOT bind tier: substituting the tier still verifies (documented caveat)', () => {
    const r = verify(PROOF_B64, { ...HONEST, tier: 'VETERAN' });
    expect(r.verified).toBe(true);
  });
});

describe('fail-closed: a verifier that cannot run must never read as verified', () => {
  it('the real verifier still passes the honest proof THROUGH the fail-closed boundary', () => {
    const r = verifyFailClosed((p, s) => verify(p, s), PROOF_B64, HONEST);
    expect(r.verified).toBe(true);
  });

  it('verifier UNAVAILABLE (throws, e.g. WASM failed to load) → verified === false', () => {
    const r = verifyFailClosed(() => {
      throw new Error('WASM module not found');
    }, PROOF_B64, HONEST);
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/unavailable/i);
  });

  it('verifier returns a non-boolean/garbage shape → verified === false (no truthy coercion)', () => {
    // The classic bug this guards: `!!result` on an object is always true. A `{ok:1}` shape or a
    // bare string must resolve to false, not slip through as verified.
    for (const bad of [{ ok: 1 } as unknown, 'true' as unknown, 1 as unknown, null as unknown]) {
      const r = verifyFailClosed(() => bad, PROOF_B64, HONEST);
      expect(r.verified).toBe(false);
    }
  });
});
