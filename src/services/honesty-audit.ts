/**
 * PHASE A — Honesty-stack audit.
 *
 * Folds agent_id into the verdict's honesty stack (prompt_hash, decision_text_hash, nonce, timestamp)
 * to produce the bound commitment, and HASHES the full stack into hal_audit_chain (tamper-evident,
 * advisory-locked, Merkle-anchored). Returns the commitment so the caller can ALSO fold it into the
 * proof's zk_commitment — tying the queued/anchored artifact to THIS decision, agent, prompt, and time.
 *
 * Integrity rule: this NEVER silently swallows. The hal_audit_chain IS the integrity surface, so an
 * append failure is logged LOUD (it signals a real integrity gap to investigate) but is non-fatal to
 * scoring — the commitment is still returned and bound.
 */
import { buildHonestyCommitment, type HonestyStack } from '../zkp/commitment';
import { appendToAuditChain } from './auditChainWriter';

export type HonestyAuditInput = HonestyStack;

export interface HonestyAuditResult {
  /** The honesty commitment bound to this verdict — fold into the proof's zk_commitment. */
  commitment: string;
  /** Whether the stack was successfully hashed into hal_audit_chain. */
  appended: boolean;
}

/**
 * Build the bound honesty commitment and append the full honesty stack to hal_audit_chain.
 * `source_id` is the commitment itself, so the chain entry is addressable by the commitment that
 * also lands in zk_commitment.
 */
export async function recordHonesty(input: HonestyAuditInput): Promise<HonestyAuditResult> {
  const commitment = buildHonestyCommitment(input);
  try {
    await appendToAuditChain('sbfa_honesty', commitment, {
      agent_id: input.agent_id,
      prompt_hash: input.prompt_hash,
      decision_text_hash: input.decision_text_hash,
      nonce: input.nonce,
      timestamp: input.timestamp,
      sbfa_decision: input.sbfa_decision ?? null,
      hal_score: input.hal_score ?? null,
      honesty_commitment: commitment,
    });
    return { commitment, appended: true };
  } catch (err) {
    console.error(
      '[honesty-audit] FAILED to hash the honesty stack into hal_audit_chain (integrity gap — investigate):',
      err instanceof Error ? err.message : err
    );
    return { commitment, appended: false };
  }
}
