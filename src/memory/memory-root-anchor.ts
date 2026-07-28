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
import { AbiCoder } from 'ethers';
import { attestProof, redTeamPayloadMatch, type ProofAttestInput } from '../services/eas-attestation-service';

export const MEMORY_ROOT_PROOF_TYPE = 'PCR_MEMORY_ROOT';

/**
 * The full decoded `constitutional-compliance-v1` payload — ALL SIX fields.
 *
 * Six are written; the existing verification path (`redTeamPayloadMatch`) decodes six and compares
 * three (agentId, tier, merkleRoot), discarding `proofType` and `proofId`. That is sound for what it
 * was written to do — red-team a merkle root against its DB row — and it is exactly one field short
 * of what a memory-root anchor needs, twice over:
 *
 *   • `proofType` is the DOMAIN. Without it, an attestation of any other kind (the encoder's default
 *     is `'POSTCARD'`) carrying the same agent/tier/root verifies as a memory-root anchor.
 *   • `proofId` is the EPOCH — the field `buildMemoryRootAttest` deliberately carries so a root can
 *     be placed in time. Without it, an anchor made at epoch M satisfies a publication claiming
 *     epoch N. Freshness is the property the epoch exists to provide, and it was written but never
 *     read.
 *
 * So this type exists to make all six available to a checker that wants them. See
 * `verifyPublication` in `memory-publication.ts`, which is the checker that does.
 */
export interface AnchorFields {
  agentId: string;
  tier: string;
  merkleRoot: string;
  repidSnapshot: bigint;
  proofType: string;
  proofId: bigint;
}

/** ABI types of `PROOF_SCHEMA_DEF`, in order. Kept adjacent to the decoder that consumes them. */
const ANCHOR_ABI_TYPES = ['string', 'string', 'bytes32', 'uint256', 'string', 'uint64'];

/**
 * Decode an on-chain attestation's `data` blob into all six fields. Pure and TOTAL: the input comes
 * off-chain from an untrusted `getAttestation` response, so a truncated, mis-schema'd, or non-hex
 * blob yields `null` — never a throw. `null` means "not a payload of this schema", which a caller
 * must treat as a failed binding, not as an absent constraint.
 */
export function decodeAnchorFields(dataHex: string): AnchorFields | null {
  if (typeof dataHex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(dataHex)) return null;
  try {
    const d = AbiCoder.defaultAbiCoder().decode(ANCHOR_ABI_TYPES, dataHex);
    return {
      agentId: String(d[0]), tier: String(d[1]), merkleRoot: String(d[2]),
      repidSnapshot: BigInt(d[3]), proofType: String(d[4]), proofId: BigInt(d[5]),
    };
  } catch { return null; }
}

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
