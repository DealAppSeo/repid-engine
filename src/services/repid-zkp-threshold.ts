/**
 * RepID threshold ZKP — server-side prover/verifier (v0.1 stub).
 *
 * Implements the rep_id_threshold circuit shape from
 * `repid/spec/ZKP-REPID-PROOF.md`:
 *
 *   Statement:  R >= T  AND  C == H(holderAddress || nonce)
 *   Public:     [T, C]
 *   Witness:    [R, nonce, holderAddress]
 *
 * v0.1 implementation is a STUB — no real Plonky3 circuit. The "proof"
 * is an HMAC-SHA256 over the statement-relevant inputs, same convention
 * as the existing /prove-repid endpoint and src/zkp/plonky3-real.ts.
 * Every response carries `mock_proof: true` and `plonky3_version:
 * 'babybear-stub-v1'` so callers know what they're getting.
 *
 * The Plonky3 wrapper signature is preserved: when Sprint 3 lands a real
 * circuit, callers do not need to change. Only the body of generate()
 * and verify() flips to the real implementation.
 */

import { createHash, createHmac } from 'crypto';
import { ethers } from 'ethers';
import { db } from '../db';
import { appendToAuditChain } from './auditChainWriter';

const PROOF_SECRET = process.env.PROOF_SECRET || 'repid-default-secret';
const PLONKY3_VERSION = 'babybear-stub-v1';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProveThresholdInput {
  holder: string;
  threshold: number;
  /** Optional caller-supplied nonce (hex). When omitted, a deterministic
   *  per-holder nonce is derived so the same (holder, threshold) pair
   *  produces the same proof — convenient for the demo. v0.2 will
   *  randomise per-call nonces. */
  nonce?: string;
}

export interface ThresholdProofPublicSignals {
  threshold: number;
  holder_commitment: string;
}

export interface ProveThresholdResult {
  ok: boolean;
  proof_bytes: string | null;
  public_signals: ThresholdProofPublicSignals | null;
  plonky3_version: string;
  mock_proof: true;
  rep_id_actual: number | null;       // present in v0.1 stub for inspection; v0.2 real circuit hides this
  threshold_met: boolean;
  audit_chain_id: number | null;
  generated_at: string;
  notes: string;
  error?: string;
}

export interface VerifyThresholdInput {
  proof_bytes: string;
  public_signals: ThresholdProofPublicSignals;
}

export interface VerifyThresholdResult {
  valid: boolean;
  on_chain_verifiable: boolean;
  plonky3_version: string;
  reason?: string;
  audit_chain_id: number | null;
  notes: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic holder commitment matches the spec:
 *   C == H(holderAddress || nonce)
 *
 * Same shape we use at SBT mint time (see sbt-mint.computeRepIdCommitment),
 * so a holder's mint-time commitment and a later threshold-proof
 * commitment open to the same nonce when supplied consistently.
 */
function holderCommitment(holder: string, nonce: string): string {
  const norm = ethers.getAddress(holder);
  return '0x' + createHash('sha256')
    .update(Buffer.concat([
      Buffer.from(norm.slice(2), 'hex'),
      Buffer.from(nonce.replace(/^0x/, ''), 'hex'),
    ]))
    .digest('hex');
}

function defaultNonceFor(holder: string): string {
  const norm = ethers.getAddress(holder);
  return '0x' + createHash('sha256').update('default-nonce:' + norm).digest('hex');
}

/**
 * Mock proof body. HMAC over the statement's inputs. Verifier re-hashes
 * with the same secret + same public signals + same witness fragments
 * and checks equality.
 *
 * In a real Plonky3 prover, the witness ([R, nonce, holderAddress]) does
 * NOT appear in the verify path. The stub leaks them by necessity so the
 * verifier can re-hash; we mark this clearly in the notes field.
 */
function generateMockProof(
  threshold: number,
  holder: string,
  repId: number,
  nonce: string,
): string {
  return createHmac('sha256', PROOF_SECRET)
    .update(`v1|T=${threshold}|H=${ethers.getAddress(holder)}|R=${repId}|N=${nonce}`)
    .digest('base64');
}

async function fetchHolderRepId(holder: string): Promise<number | null> {
  // Strategy: agent_kya_registry is the canonical source for fleet
  // agents; for arbitrary humans we look at repid_agents.current_repid.
  // Both queries are best-effort; if neither finds a row we treat the
  // holder as having repId=0 (the spec's "initial" state).
  const norm = ethers.getAddress(holder);

  // 1. agent_kya_registry by repid_score
  const { data: kya } = await db
    .from('agent_kya_registry')
    .select('repid_score')
    .ilike('agent_name', norm)            // tolerate either an address or an agent name
    .limit(1)
    .maybeSingle();
  if (kya?.repid_score !== undefined && kya.repid_score !== null) {
    return Number(kya.repid_score);
  }

  // 2. repid_agents.current_repid by erc8004_address
  const { data: ag } = await db
    .from('repid_agents')
    .select('current_repid')
    .eq('erc8004_address', norm)
    .limit(1)
    .maybeSingle();
  if (ag?.current_repid !== undefined && ag.current_repid !== null) {
    return Number(ag.current_repid);
  }

  // 3. Fallback: 0 (per spec — every new holder starts at 0).
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function proveThreshold(input: ProveThresholdInput): Promise<ProveThresholdResult> {
  const generatedAt = new Date().toISOString();
  if (!ethers.isAddress(input.holder)) {
    return errorResult('invalid holder address');
  }
  if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 10000) {
    return errorResult('threshold must be a number in [0, 10000]');
  }

  const holder = ethers.getAddress(input.holder);
  const nonce = input.nonce ?? defaultNonceFor(holder);

  // Per the spec: the prover MUST fail when R < T (witness invalid).
  const repId = await fetchHolderRepId(holder);
  if (repId === null) {
    return errorResult('holder rep id not found');
  }
  if (repId < input.threshold) {
    // No proof emitted — but still record the attempt for the audit chain.
    const result: ProveThresholdResult = {
      ok: false,
      proof_bytes: null,
      public_signals: null,
      plonky3_version: PLONKY3_VERSION,
      mock_proof: true,
      rep_id_actual: repId,
      threshold_met: false,
      audit_chain_id: null,
      generated_at: generatedAt,
      notes: 'MOCK_PROOF — witness invalid (R < T). In a real Plonky3 prover this would be a witness-validation failure with no proof emitted.',
      error: 'witness_invalid_R_lt_T',
    };
    try {
      const audit = await appendToAuditChain('repid_threshold_proofs', `attempt-${holder}-${input.threshold}-${generatedAt}`, {
        event_type: 'repid_threshold_proof_attempt',
        outcome: 'witness_invalid',
        threshold: input.threshold,
        holder,
        plonky3_version: PLONKY3_VERSION,
        is_mock: true,
      });
      result.audit_chain_id = audit.id;
    } catch { /* non-fatal */ }
    return result;
  }

  const c = holderCommitment(holder, nonce);
  const proof = generateMockProof(input.threshold, holder, repId, nonce);

  let auditId: number | null = null;
  try {
    const audit = await appendToAuditChain('repid_threshold_proofs', `proof-${holder}-${input.threshold}-${generatedAt}`, {
      event_type: 'repid_threshold_proof_generated',
      outcome: 'ok',
      threshold: input.threshold,
      holder,
      holder_commitment: c,
      plonky3_version: PLONKY3_VERSION,
      is_mock: true,
    });
    auditId = audit.id;
  } catch (e: any) {
    console.warn('[repid-zkp] audit append failed:', e?.message);
  }

  return {
    ok: true,
    proof_bytes: proof,
    public_signals: { threshold: input.threshold, holder_commitment: c },
    plonky3_version: PLONKY3_VERSION,
    mock_proof: true,
    rep_id_actual: repId,
    threshold_met: true,
    audit_chain_id: auditId,
    generated_at: generatedAt,
    notes: 'MOCK_PROOF — HMAC stub. v0.2 swaps in real Plonky3 circuit; the response shape is stable.',
  };
}

/**
 * Re-hashes inputs against the same HMAC secret to validate the proof.
 *
 * Caveat: the HMAC stub requires the verifier to know the witness
 * (R, nonce, holderAddress) to reproduce the hash. The endpoint's
 * verify path therefore needs the witness echoed back — which is
 * exactly the privacy property a real circuit eliminates. This shim
 * accepts the proof + public signals + an OPTIONAL witness for
 * convenience; if witness is not supplied the verify call returns
 * `valid: false` with reason 'witness_required_for_stub'.
 *
 * In a real circuit, only public_signals would be needed.
 */
export async function verifyThreshold(
  input: VerifyThresholdInput & { _witness?: { holder: string; nonce: string; rep_id: number } },
): Promise<VerifyThresholdResult> {
  const sigs = input.public_signals;
  if (!sigs || typeof sigs.threshold !== 'number' || typeof sigs.holder_commitment !== 'string') {
    return errResult('public_signals malformed');
  }

  if (!input._witness) {
    return errResult('witness_required_for_stub');
  }
  const { holder, nonce, rep_id: repId } = input._witness;
  if (!ethers.isAddress(holder)) return errResult('witness.holder invalid');

  // Recompute commitment + proof and compare.
  const c = holderCommitment(holder, nonce);
  if (c !== sigs.holder_commitment) {
    return errResult('commitment_mismatch');
  }
  if (repId < sigs.threshold) {
    return errResult('threshold_not_met');
  }
  const expected = generateMockProof(sigs.threshold, holder, repId, nonce);
  if (expected !== input.proof_bytes) {
    return errResult('proof_bytes_mismatch');
  }

  let auditId: number | null = null;
  try {
    const audit = await appendToAuditChain('repid_threshold_proofs', `verify-${holder}-${sigs.threshold}-${new Date().toISOString()}`, {
      event_type: 'repid_threshold_proof_verified',
      outcome: 'valid',
      threshold: sigs.threshold,
      holder,
      holder_commitment: c,
      plonky3_version: PLONKY3_VERSION,
      is_mock: true,
    });
    auditId = audit.id;
  } catch { /* non-fatal */ }

  return {
    valid: true,
    on_chain_verifiable: false,
    plonky3_version: PLONKY3_VERSION,
    audit_chain_id: auditId,
    notes: 'MOCK_PROOF verified. on_chain_verifiable=false because the v0.1 stub does not emit a contract-compatible Plonky3 proof.',
  };
}

function errorResult(error: string): ProveThresholdResult {
  return {
    ok: false,
    proof_bytes: null,
    public_signals: null,
    plonky3_version: PLONKY3_VERSION,
    mock_proof: true,
    rep_id_actual: null,
    threshold_met: false,
    audit_chain_id: null,
    generated_at: new Date().toISOString(),
    notes: 'MOCK_PROOF — error during proof generation.',
    error,
  };
}

function errResult(reason: string): VerifyThresholdResult {
  return {
    valid: false,
    on_chain_verifiable: false,
    plonky3_version: PLONKY3_VERSION,
    reason,
    audit_chain_id: null,
    notes: 'MOCK_PROOF verifier — invalid.',
  };
}

// Pure helpers exposed for tests so they don't need to mock Supabase.
export const _internals = {
  holderCommitment,
  defaultNonceFor,
  generateMockProof,
};
