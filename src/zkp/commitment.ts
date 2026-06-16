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

/** sha256(text) as 0x-hex. Hash-agnostic helper (swaps to Poseidon2 with the migration). */
export function hashText(text: string): string {
  return '0x' + createHash('sha256').update(text ?? '').digest('hex');
}

/**
 * PHASE A — the HONESTY STACK bound into the SBFA verdict + zk_commitment.
 *
 * Binds the *decision provenance* — which prompt, which decision text, which agent, a fresh nonce,
 * and a timestamp — so a stored verdict/commitment can't be silently swapped, replayed, or
 * back-dated. Any change to ANY field changes the commitment (tamper-evident). The same construction
 * holds when the inner hash becomes Poseidon2 (Invariant 1); sha256 here matches the live 0x-hex
 * family so it is drop-in compatible today.
 */
export interface HonestyStack {
  agent_id: string;
  prompt_hash: string; // hashText(input prompt / deliverable)
  decision_text_hash: string; // hashText(decision + reason + belief/ignorance)
  nonce: string; // generateNonce() — fresh per verdict
  timestamp: string; // ISO-8601, bound so a verdict can't be back-dated
  sbfa_decision?: string; // 'act'|'hold'|'abstain'|'escalate'
  hal_score?: number;
}

/**
 * Deterministic over the honesty stack; unique per verdict via the nonce; tamper-evident (any field
 * change ⇒ a different commitment). This is the value bound into the SBFA verdict AND folded into the
 * proof's zk_commitment so the queued/anchored artifact is provably tied to THIS decision.
 */
export function buildHonestyCommitment(h: HonestyStack): string {
  const parts = [
    'honesty_v1',
    h.agent_id,
    h.prompt_hash,
    h.decision_text_hash,
    h.nonce,
    h.timestamp,
    h.sbfa_decision ?? '',
    h.hal_score == null ? '' : h.hal_score.toFixed(6),
  ].join('|');
  return '0x' + createHash('sha256').update(parts).digest('hex');
}
