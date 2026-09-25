/**
 * Local plonky3_range_check check.
 *
 * Same Node WASM entry the cross-crate test calls
 * (`@hyperdag/proof-verifier/pkg-node`). No prover call, no minter, no chain write.
 * A throw or a non-boolean result is not verified.
 */

export interface RangeCheckVerifyResult {
  verified: boolean;
  error: string | null;
  proof_size_bytes: number;
  verifier_version: string;
  scheme: 'plonky3_range_check';
}

interface WasmVerifier {
  init_panic_hook(): void;
  verify_proof(inputJson: string): string;
}

function loadVerifier(): WasmVerifier {
  // The package's Node target is CommonJS. The ESM wrapper fights jest's loader.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js') as WasmVerifier;
}

export function verifyRangeCheck(
  proofBytes: string,
  statement: Record<string, unknown>,
): RangeCheckVerifyResult {
  const fail = (error: string): RangeCheckVerifyResult => ({
    verified: false,
    error,
    proof_size_bytes: 0,
    verifier_version: 'unknown',
    scheme: 'plonky3_range_check',
  });
  try {
    const verifier = loadVerifier();
    verifier.init_panic_hook();
    const raw = JSON.parse(
      verifier.verify_proof(JSON.stringify({ proof_bytes: proofBytes, statement })),
    ) as Partial<RangeCheckVerifyResult>;
    if (typeof raw.verified !== 'boolean') return fail('verifier returned an unexpected shape');
    return {
      verified: raw.verified,
      error: typeof raw.error === 'string' ? raw.error : null,
      proof_size_bytes: typeof raw.proof_size_bytes === 'number' ? raw.proof_size_bytes : 0,
      verifier_version: typeof raw.verifier_version === 'string' ? raw.verifier_version : 'unknown',
      scheme: 'plonky3_range_check',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}
