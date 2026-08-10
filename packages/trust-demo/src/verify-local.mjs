/**
 * verify-local.mjs — the fail-closed wrapper around the real STARK verifier.
 *
 * WHY THIS IS DUPLICATED FROM src/services/trust-harness-verify.ts, AND WHY THAT IS
 * THE RIGHT CALL HERE. This package is published to npm and run via `npx` by people
 * who have never cloned this repo. It therefore cannot import from `src/` (TypeScript)
 * or `dist/` (a build artefact that does not exist in the published tarball). The same
 * reasoning already governs `scripts/hooks/lane-write-guard.js`, which duplicates
 * `write-lease.ts` for exactly this reason: a dependency is a way to fail, and a
 * verifier that fails is a verifier that fails OPEN.
 *
 * The duplication is held honest by `tests/trust-demo-verify-equivalence.test.ts`,
 * which runs BOTH implementations over the same case matrix and fails the build if
 * they ever disagree. Duplication with an equivalence test beats a dependency that
 * breaks at the worst moment.
 *
 * THE RULE THIS ENCODES: a pass is returned ONLY when a real verifier returned
 * `verified === true`. No verifier, no bytes, no statement, a thrown error, a
 * non-boolean `verified`, or `verified === false` are all failures. There is
 * deliberately no byte-count shortcut and no "the server said so" shortcut — the
 * entire argument of this demo is that you do not have to trust the server.
 */

/**
 * @typedef {object} LocalVerifyResult
 * @property {boolean} verified
 * @property {string} reason
 * @property {string|null} verifierVersion
 * @property {number|null} proofSizeBytes
 */

/**
 * @param {{proofBytes: unknown, statement: unknown, verifyFn: unknown}} input
 * @returns {Promise<LocalVerifyResult>}
 */
export async function verifyProofLocally(input) {
  /** @type {(reason: string) => LocalVerifyResult} */
  const fail = (reason) => ({ verified: false, reason, verifierVersion: null, proofSizeBytes: null });

  if (typeof input.verifyFn !== 'function') {
    return fail('local verifier unavailable (@hyperdag/proof-verifier not loaded) — fail-closed');
  }
  if (typeof input.proofBytes !== 'string' || input.proofBytes.length === 0) {
    return fail('no proof bytes to verify (legacy sha256 stub or empty proof)');
  }
  if (!input.statement || typeof input.statement !== 'object') {
    return fail('no statement to verify the proof against');
  }

  let result;
  try {
    result = await input.verifyFn(input.proofBytes, input.statement);
  } catch (e) {
    return fail(`verifier threw — ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!result || typeof result !== 'object' || typeof result.verified !== 'boolean') {
    // `!!result` on an object is always true — a non-boolean `verified` is exactly how a
    // fake "truthy" verification slips through. Refuse it.
    return fail('verifier returned an unexpected shape (verified is not a boolean)');
  }

  const verifierVersion = typeof result.verifier_version === 'string' ? result.verifier_version : null;
  const proofSizeBytes = typeof result.proof_size_bytes === 'number' ? result.proof_size_bytes : null;

  if (result.verified !== true) {
    const err = typeof result.error === 'string' && result.error ? result.error : 'verification returned false';
    return {
      verified: false,
      reason: `proof REJECTED by the local STARK verifier — ${err}`,
      verifierVersion,
      proofSizeBytes,
    };
  }

  return {
    verified: true,
    reason: 'proof verified locally by the STARK verifier',
    verifierVersion,
    proofSizeBytes,
  };
}

/**
 * The exact field set `@hyperdag/proof-verifier` v0.2.0 requires. Verified empirically:
 * a statement missing `agent_id` fails with "missing field `agent_id`" and one missing
 * `tier` fails with "missing field `tier`" — both BEFORE the proof is even decoded.
 *
 * This matters because `repid_zkp_proofs.statement` stores only {repid_score, threshold};
 * `GET /api/v1/repid/:id/proof` synthesises the other two. Checking the shape here turns
 * a confusing parse error into a sentence that names the missing field.
 */
export const REQUIRED_STATEMENT_FIELDS = Object.freeze(['agent_id', 'repid_score', 'threshold', 'tier']);

/** @param {Record<string, unknown>|null|undefined} statement */
export function missingStatementFields(statement) {
  if (!statement || typeof statement !== 'object') return [...REQUIRED_STATEMENT_FIELDS];
  return REQUIRED_STATEMENT_FIELDS.filter((f) => statement[f] === undefined || statement[f] === null);
}
