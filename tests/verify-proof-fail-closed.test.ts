/**
 * POST /api/v1/verify-proof — the crypto path must FAIL CLOSED.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `verifyProofCryptographically` in `src/routes/v1.ts` used to do:
 *
 *     const valid = await verifierMod.verify(proofRow.proof_bytes, publicInputs);
 *     return { valid: !!valid, cryptographically_verified: true, ... };
 *
 * `@hyperdag/proof-verifier`'s `verify()` resolves to an OBJECT
 * (`{verified, error, proof_size_bytes, verifier_version}`), and `!!someObject` is
 * always `true`. Every stored proof with non-empty `proof_bytes` therefore came back
 * `valid: true, cryptographically_verified: true` — including proofs the verifier had
 * just REJECTED. The catch block asserted `cryptographically_verified: true` on a WASM
 * failure too, claiming a cryptographic check on the one path where none completed.
 * That is a live fail-open on the flagship trust claim of the product.
 *
 * The fail-closed boundary already existed (`verifyProofLocally` in
 * `src/services/trust-harness-verify.ts`) and simply had no caller here — LESSONS 3,
 * an unwired mechanism is worse than an absent one. `tests/zkp-proof-verifier-crosscheck.test.ts`
 * already pinned the same property one layer down ("the classic bug this guards: `!!result`
 * on an object is always true"), and it stayed green while this endpoint shipped the bug —
 * which is exactly why the assertion has to be made against the ENDPOINT's own function.
 *
 * WHY THE VERIFIER IS INJECTED HERE
 * ---------------------------------
 * The real WASM is exercised against a genuine synthetic proof in
 * `zkp-proof-verifier-crosscheck.test.ts`. What is under test here is the CONSUMER's
 * handling of the verifier's return value, so the return value has to be driven — including
 * shapes a healthy verifier never emits (a truthy non-boolean, a throw). Those are precisely
 * the inputs the old code got wrong.
 *
 * It is injected rather than `jest.mock`ed because the production loader is a NATIVE dynamic
 * `import()` of an ESM-only package: inside jest's vm sandbox that call throws
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` and never consults the module registry, so a
 * `jest.mock('@hyperdag/proof-verifier', …)` factory is silently NEVER CALLED — every case
 * would fall into the "verifier unavailable" branch and the suite would pass for the wrong
 * reason. Measured, not assumed: the same loader resolves `verify` fine under plain
 * `node -e "import('@hyperdag/proof-verifier')"`, so this is a jest limitation, not a broken
 * dependency. `verifyProofCryptographically` therefore takes an optional third argument; the
 * route passes nothing and keeps the real loader.
 *
 * THREE OUTCOMES, NEVER TWO
 * -------------------------
 *   VERIFIED    → { valid: true,  cryptographically_verified: true  }
 *   FAILED      → { valid: false, cryptographically_verified: true  }  verifier ran, rejected
 *   NOT CHECKED → { valid: false, cryptographically_verified: false }  unavailable/threw/shape
 * Collapsing the last two is what let "we did not look" read as "it passed".
 */

// v1.ts pulls in the whole service surface; mock db so nothing touches Supabase.
jest.mock('../src/db', () => ({
  db: { from: jest.fn() },
}));

import { verifyProofCryptographically } from '../src/routes/v1';
import type { VerifyFn } from '../src/services/trust-harness-verify';

/** Stands in for `@hyperdag/proof-verifier`'s verify(); see the header for why it is injected. */
const verify = jest.fn() as jest.MockedFunction<VerifyFn>;

const STATEMENT = {
  agent_id: '00000000-0000-4000-8000-0000000000aa',
  tier: 'ESTABLISHED',
  repid_score: 1400,
  threshold: 1000,
};

/** A row that carries real proof bytes — i.e. one that takes the cryptographic path. */
const PROOF_ROW = {
  id: 1,
  agent_id: STATEMENT.agent_id,
  tier_proven: 'ESTABLISHED',
  proof_bytes: 'ZmFrZS1wcm9vZi1ieXRlcw==',
  statement: STATEMENT,
};

beforeEach(() => {
  verify.mockReset();
});

describe('verify-proof crypto path: a verifier verdict of FALSE must not read as valid', () => {
  it('verifier returns {verified:false} → valid:false (the object is not coerced to true)', async () => {
    verify.mockResolvedValue({
      verified: false,
      error: 'InvalidOpeningArgument',
      proof_size_bytes: 4096,
      verifier_version: '0.2.0',
    });

    const r = await verifyProofCryptographically(PROOF_ROW, undefined, verify);

    expect(r.valid).toBe(false);
    // The check DID run and DID return a verdict — that is FAILED, not NOT CHECKED.
    expect(r.cryptographically_verified).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('the honest path still passes: {verified:true} → valid:true (not fail-closed on everything)', async () => {
    verify.mockResolvedValue({
      verified: true,
      error: null,
      proof_size_bytes: 4096,
      verifier_version: '0.2.0',
    });

    const r = await verifyProofCryptographically(PROOF_ROW, undefined, verify);

    expect(r.valid).toBe(true);
    expect(r.cryptographically_verified).toBe(true);
  });
});

describe('verify-proof crypto path: an unusable verifier must never read as verified', () => {
  // Each of these is truthy, so each one passed the old `!!valid` gate.
  const garbage: unknown[] = [{ ok: 1 }, { verified: 'true' }, 'true', 1, [], () => true];

  it.each(garbage.map((g) => [JSON.stringify(g) ?? String(g), g] as const))(
    'verifier returns a truthy non-boolean shape %s → valid:false and NOT cryptographically verified',
    async (_label, bad) => {
      verify.mockResolvedValue(bad as any);

      const r = await verifyProofCryptographically(PROOF_ROW, undefined, verify);

      expect(r.valid).toBe(false);
      // No genuine boolean verdict was produced, so no cryptographic check may be claimed.
      expect(r.cryptographically_verified).toBe(false);
    },
  );

  it('verifier THROWS (WASM failed to load / panicked) → valid:false and NOT cryptographically verified', async () => {
    verify.mockRejectedValue(new Error('WASM module not found'));

    const r = await verifyProofCryptographically(PROOF_ROW, undefined, verify);

    expect(r.valid).toBe(false);
    // The old catch block returned `cryptographically_verified: true` here — claiming a
    // cryptographic verification on the exact path where none happened.
    expect(r.cryptographically_verified).toBe(false);
    expect(r.cryptographically_verified).not.toBe(true);
  });

  it('a failed verification reports a reason rather than a bare false', async () => {
    verify.mockResolvedValue({ ok: 1 } as any);

    const r = await verifyProofCryptographically(PROOF_ROW, undefined, verify);

    expect(typeof (r as any).error).toBe('string');
    expect((r as any).error.length).toBeGreaterThan(0);
  });
});

describe('verify-proof: the ATTESTED path is unchanged (no silent semantics change)', () => {
  // Rows without proof_bytes are today's sha256/HMAC stubs. They report an attestation, and
  // report honestly that it is NOT a cryptographic verification. This test exists so that
  // fixing the crypto path above cannot quietly redefine the attested one.
  it('no proof_bytes but an attestation column present → valid:true, cryptographically_verified:false', async () => {
    const r = await verifyProofCryptographically({
      id: 2,
      agent_id: STATEMENT.agent_id,
      tier_proven: 'ESTABLISHED',
      merkle_root: '0xabc',
    });

    expect(r.valid).toBe(true);
    expect(r.cryptographically_verified).toBe(false);
    expect((r as any).message).toBe('attested, not cryptographically verified');
    expect(verify).not.toHaveBeenCalled();
  });

  it('no proof_bytes and no attestation column → valid:false', async () => {
    const r = await verifyProofCryptographically({
      id: 3,
      agent_id: STATEMENT.agent_id,
      tier_proven: 'ESTABLISHED',
    });

    expect(r.valid).toBe(false);
    expect(r.cryptographically_verified).toBe(false);
  });

  it('no proof row at all → valid:false', async () => {
    const r = await verifyProofCryptographically(null);
    expect(r.valid).toBe(false);
    expect(r.cryptographically_verified).toBe(false);
  });
});
