/**
 * Pure, unit-tested helpers for the trust-harness E2E demo
 * (scripts/demo/trust-harness-e2e.mjs). The demo's two load-bearing decisions —
 * "did the ZK proof actually verify locally" and "is the HAL call authenticated
 * so it bypasses the public per-IP cap" — live here rather than only inside a
 * live-run script, so both are proven by a deterministic test.
 *
 * Nothing here is demo-only theatre: `verifyProofLocally` consumes the SAME
 * verify() the published `@hyperdag/proof-verifier` exposes (injected), and
 * fail-closes on every path where it cannot get a genuine `verified === true`.
 */

/** The shape `@hyperdag/proof-verifier`'s verify() returns (fields optional/untrusted). */
export interface RawVerifyResult {
  verified?: unknown;
  error?: unknown;
  proof_size_bytes?: unknown;
  verifier_version?: unknown;
}

export type VerifyFn = (
  proofBytes: string,
  statement: Record<string, unknown>,
) => Promise<RawVerifyResult>;

export interface LocalVerifyInput {
  /** Base64-encoded proof bytes as returned by /api/v1/repid/:agent/proof. */
  proofBytes: string | null | undefined;
  /** The public statement the proof binds (agent_id, repid_score, threshold, tier). */
  statement: Record<string, unknown> | null | undefined;
  /** The real verifier (published package's verify). Injected; null when unavailable. */
  verifyFn: VerifyFn | null | undefined;
}

export interface LocalVerifyResult {
  verified: boolean;
  reason: string;
  verifierVersion: string | null;
  proofSizeBytes: number | null;
}

/**
 * Verify a proof LOCALLY, fail-closed. A pass is returned ONLY when a real
 * verifier returned `verified === true`. Every other outcome — no verifier, no
 * bytes, an unexpected shape, a thrown error, or `verified !== true` — is a
 * failure. There is deliberately no byte-count or state-based shortcut: a proof
 * we did not cryptographically check is not a proof we can vouch for.
 */
export async function verifyProofLocally(input: LocalVerifyInput): Promise<LocalVerifyResult> {
  const fail = (reason: string): LocalVerifyResult => ({
    verified: false,
    reason,
    verifierVersion: null,
    proofSizeBytes: null,
  });

  if (typeof input.verifyFn !== 'function') {
    return fail('local verifier unavailable (@hyperdag/proof-verifier not loaded) — fail-closed');
  }
  if (typeof input.proofBytes !== 'string' || input.proofBytes.length === 0) {
    return fail('no proof bytes to verify (legacy sha256 stub or empty proof)');
  }
  if (!input.statement || typeof input.statement !== 'object') {
    return fail('no statement to verify the proof against');
  }

  let result: RawVerifyResult;
  try {
    result = await input.verifyFn(input.proofBytes, input.statement);
  } catch (e) {
    return fail(`verifier threw — ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!result || typeof result !== 'object' || typeof result.verified !== 'boolean') {
    // `!!result` on an object is always true — a non-boolean `verified` is exactly
    // how a fake "truthy" verification slips through. Refuse it.
    return fail('verifier returned an unexpected shape (verified is not a boolean)');
  }

  const verifierVersion =
    typeof result.verifier_version === 'string' ? result.verifier_version : null;
  const proofSizeBytes =
    typeof result.proof_size_bytes === 'number' ? result.proof_size_bytes : null;

  if (result.verified !== true) {
    const err =
      typeof result.error === 'string' && result.error ? result.error : 'verification returned false';
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

export interface HalRequestHeaders {
  headers: Record<string, string>;
  authenticated: boolean;
}

/**
 * Build the headers for the HAL /evaluate call. When REPID_API_KEY is present it
 * is sent as a Bearer token so an authenticated run bypasses the public per-IP
 * cap (HAL_PUBLIC_RATE_LIMIT). When absent, the call is keyless and the demo
 * keeps its honest UNKNOWN on a 429 rather than faking a verdict.
 */
export function halRequestHeaders(env: NodeJS.ProcessEnv = process.env): HalRequestHeaders {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = typeof env.REPID_API_KEY === 'string' ? env.REPID_API_KEY.trim() : '';
  if (key.length > 0) {
    headers['Authorization'] = `Bearer ${key}`;
    return { headers, authenticated: true };
  }
  return { headers, authenticated: false };
}
