/**
 * memory-root-anchor.ts — P3 of PROOF_CARRYING_RETRIEVAL_v0 (D-094).
 *
 * EAS-anchors a committed proof-carrying memory root (from P2) on Base Sepolia,
 * making the whole memory publicly timestamped + non-repudiable: anyone can later
 * fetch the on-chain attestation and confirm an inclusion/answer proof was against
 * a root the agent had actually committed at that time.
 *
 * REUSES the existing EAS rail (eas-attestation-service): the memory root maps onto
 * the live `constitutional-compliance-v1` schema with proofType='PCR_MEMORY_ROOT' —
 * no new schema, no new on-chain infra, rides the funded HYPERDAG attester.
 *
 * The chain write is INJECTED (default = the real attestProof) so this is unit-testable
 * offline. Off-peak batching (isOffPeakHour/selectOffPeakBatch) is the ANFIS SCHEDULE
 * axis: anchoring is non-urgent → defer to low-gas windows.
 */
import { attestProof, redTeamPayloadMatch, type ProofAttestInput } from '../services/eas-attestation-service';

export const MEMORY_ROOT_PROOF_TYPE = 'PCR_MEMORY_ROOT';

export interface MemoryRootAnchorParams {
  agentId: string;
  tier: string;
  root: string;              // 0x + 64 hex — the committed memory root (bytes32)
  epoch: number;             // monotonically-increasing epoch → carried as proofId
  repidSnapshot?: number | null;
}

export type AttestFn = (input: ProofAttestInput) => Promise<{ uid: string | null; txHash: string | null; error?: string }>;
export type MatchFn = (row: { id: number; agent_id: string | null; tier_proven: string; merkle_root: string | null; eas_attestation_uid: string | null }) => Promise<{ match: boolean; details: string; explorer?: string }>;

const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

/** Map a committed memory root onto the existing EAS proof schema (reuse — no new schema). Pure. */
export function buildMemoryRootAttest(p: MemoryRootAnchorParams): ProofAttestInput {
  return {
    proofId: p.epoch,
    agentId: p.agentId,
    tier: p.tier,
    merkleRoot: p.root,
    repidSnapshot: p.repidSnapshot ?? null,
    proofType: MEMORY_ROOT_PROOF_TYPE,
  };
}

/** Anchor one memory root to EAS. Chain write injected (default = real attestProof) → testable offline. */
export async function anchorMemoryRoot(
  p: MemoryRootAnchorParams, attestFn: AttestFn = attestProof,
): Promise<{ uid: string | null; txHash: string | null; anchored: boolean; error?: string }> {
  if (!ROOT_RE.test(p.root)) {
    return { uid: null, txHash: null, anchored: false, error: `invalid memory root (expected 0x+64hex): '${p.root}'` };
  }
  const r = await attestFn(buildMemoryRootAttest(p));
  return { uid: r.uid, txHash: r.txHash, anchored: !!r.uid, error: r.error };
}

/** Verify an on-chain anchor matches the local root (read-only). Match fn injected (default = redTeamPayloadMatch). */
export async function verifyMemoryRootAnchor(
  uid: string, expectedRoot: string, agentId: string, tier: string, matchFn: MatchFn = redTeamPayloadMatch,
): Promise<{ match: boolean; details: string; explorer?: string }> {
  return matchFn({ id: 0, agent_id: agentId, tier_proven: tier, merkle_root: expectedRoot, eas_attestation_uid: uid });
}

// ── Off-peak batching — anchoring is non-urgent, so defer to low-gas windows (SCHEDULE axis) ──

export interface PendingRoot extends MemoryRootAnchorParams { queuedAt?: number; }

/** UTC hour ∉ [busyStart, busyEnd) is off-peak. Pure (hour injected — no Date.now dependence). */
export function isOffPeakHour(hourUtc: number, busyStartUtc = 13, busyEndUtc = 23): boolean {
  return !(hourUtc >= busyStartUtc && hourUtc < busyEndUtc);
}

/** Which queued roots to anchor now: none unless off-peak; cap the batch. Pure. */
export function selectOffPeakBatch(pending: PendingRoot[], isOffPeak: boolean, maxBatch = 10): PendingRoot[] {
  if (!isOffPeak || maxBatch <= 0) return [];
  return pending.slice(0, maxBatch);
}
