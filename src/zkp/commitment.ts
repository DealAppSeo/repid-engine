/**
 * POSTCARD commitment construction with a per-proof nonce (sprint 2026-05-29, Part B).
 *
 * ROOT CAUSE (verified [sql:2026-05-29]): repid_zkp_proofs has 22,780 POSTCARD
 * rows but only 4,124 distinct zk_commitment values (18.1% unique). Each colliding
 * commitment maps to exactly ONE agent — the commitment is deterministic per
 * (agent, score/tier) with NO per-proof nonce, so every re-proof of an agent at a
 * stable score yields the identical commitment (top value repeated 2,775×).
 *
 * FIX (additive [rule:3]): bind a fresh per-proof nonce into the commitment so
 * every proof is unique, regardless of whether the upstream prover varies its
 * inputs.
 *
 * ┌─ HASH-TIMING FLAG (sha256 vs Poseidon2) — SURFACE, DO NOT DECIDE ─────────┐
 * │ Per ZKP_ARCHITECTURE_INVARIANTS Invariant 1, commitments should ultimately │
 * │ be Poseidon2 over a Plonky3-native field. TODAY the live path is sha256    │
 * │ (this helper matches that family so it is drop-in compatible with the      │
 * │ existing 0x-hex commitments). Whether the nonce is added NOW in sha256 or  │
 * │ deferred to land WITH the Poseidon2 migration is a Sean/XC call — this      │
 * │ helper does not pre-empt the dual-prover migration. The nonce itself is    │
 * │ hash-agnostic: the same construction holds when the inner hash becomes     │
 * │ Poseidon2. [rule:7,11]                                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import { createHash, randomBytes } from 'crypto';

/** Fresh 16-byte per-proof nonce as 0x-hex. */
export function generateNonce(): string {
  return '0x' + randomBytes(16).toString('hex');
}

export interface PostcardCommitmentInput {
  agentId: string;
  score: number;
  tier: string;
  nonce: string;
  /** The upstream prover's commitment, bound in when present (preserves the tie
   *  to the proof while the nonce guarantees uniqueness). */
  proverCommitment?: string | null;
}

/**
 * Deterministic given inputs (incl. nonce); unique across proofs because the
 * nonce is fresh per proof. Same family (sha256, 0x-hex 32 bytes) as the live
 * commitments — see the hash-timing flag above for the Poseidon2 path.
 */
export function buildPostcardCommitment(input: PostcardCommitmentInput): string {
  const parts = [
    input.agentId,
    String(input.score),
    input.tier,
    input.nonce,
    input.proverCommitment ?? '',
  ].join('|');
  return '0x' + createHash('sha256').update(parts).digest('hex');
}
