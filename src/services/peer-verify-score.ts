/**
 * Emit RepID score events after a real peer-verification verdict (Veritas path).
 * Uses pgQuery so apply_repid_score_event trigger applies current_repid in-process.
 */
import { pgQuery } from '../db/direct-pg';
import { emitOnChainOutboxEvent } from './onchain-outbox';

export interface PeerVerifyScoreInput {
  queueId: number | string;
  producerAgentId: string;
  verifierAgentId: string;
  verdict: 'verified' | 'disputed' | 'timeout';
  claimText?: string | null;
  certaintyAtClaim?: number | null;
}

export interface PeerVerifyScoreResult {
  emitted: boolean;
  producerEventId?: number;
  verifierEventId?: number;
  producerRepidAfter?: number;
  verifierRepidAfter?: number;
}

function peerVerifyRepidEnabled(): boolean {
  if ((process.env.PEER_VERIFY_REPID_ENABLED || 'true').toLowerCase() === 'false') return false;
  if ((process.env.DOGFOOD_REPID_FROM_COSIGN || 'false').toLowerCase() === 'true') return true;
  return true;
}

const VERIFIED_DELTA = Number(process.env.PEER_VERIFY_VERIFIED_DELTA || 3);
const DISPUTED_VERIFIER_DELTA = Number(process.env.PEER_VERIFY_DISPUTED_DELTA || -2);

async function insertScoreEvent(params: {
  agentId: string;
  eventType: string;
  delta: number;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  certaintyAtClaim?: number | null;
}): Promise<{ id: number; repid_after: number | null; repid_delta_applied: number | null } | null> {
  const rows = await pgQuery<{
    id: number;
    repid_after: number | null;
    repid_delta_applied: number | null;
  }>(
    `INSERT INTO repid_score_events (
       agent_id, event_type, delta, idempotency_key, metadata, certainty_at_claim
     ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, repid_after, repid_delta_applied`,
    [
      params.agentId,
      params.eventType,
      params.delta,
      params.idempotencyKey,
      JSON.stringify(params.metadata),
      params.certaintyAtClaim ?? null,
    ],
    { label: 'peer-verify-score-insert' }
  );
  return rows[0] ?? null;
}

export async function emitPeerVerifyScoreEvents(
  input: PeerVerifyScoreInput
): Promise<PeerVerifyScoreResult> {
  if (!peerVerifyRepidEnabled()) {
    return { emitted: false };
  }

  const qid = String(input.queueId);
  const claimRef = input.claimText || `queue:${qid}`;

  if (input.verdict === 'verified' && input.verifierAgentId) {
    const producer = await insertScoreEvent({
      agentId: input.producerAgentId,
      eventType: 'PEER_VERIFY_VERIFIED',
      delta: VERIFIED_DELTA,
      idempotencyKey: `peer_verify:${qid}:producer`,
      metadata: {
        role: 'producer',
        queue_id: qid,
        claim: claimRef,
        verifier_agent_id: input.verifierAgentId,
      },
      certaintyAtClaim: input.certaintyAtClaim ?? undefined,
    });
    const verifier = await insertScoreEvent({
      agentId: input.verifierAgentId,
      eventType: 'PEER_VERIFY_VERIFIED',
      delta: VERIFIED_DELTA,
      idempotencyKey: `peer_verify:${qid}:verifier`,
      metadata: {
        role: 'verifier',
        queue_id: qid,
        claim: claimRef,
      },
      certaintyAtClaim: input.certaintyAtClaim ?? undefined,
    });
    // Bridge to the ERC-8004 outbox so the verifier's (and producer's) moved
    // RepID reaches the chain via FeedbackLoopWorker. Best-effort + flag-gated
    // (default OFF); never blocks the score path. Only for real inserts.
    if (producer) {
      await emitOnChainOutboxEvent({
        subjectAgentId: input.producerAgentId,
        eventType: 'peer_verify_verified',
        reputationDelta: VERIFIED_DELTA,
        context: { queue_id: qid, role: 'producer', claim: claimRef },
      });
    }
    if (verifier) {
      await emitOnChainOutboxEvent({
        subjectAgentId: input.verifierAgentId,
        eventType: 'peer_verify_verified',
        reputationDelta: VERIFIED_DELTA,
        context: { queue_id: qid, role: 'verifier', claim: claimRef },
      });
    }

    return {
      emitted: !!(producer || verifier),
      producerEventId: producer?.id,
      verifierEventId: verifier?.id,
      producerRepidAfter: producer?.repid_after ?? undefined,
      verifierRepidAfter: verifier?.repid_after ?? undefined,
    };
  }

  if (input.verdict === 'disputed' && input.verifierAgentId) {
    const slash = await insertScoreEvent({
      agentId: input.verifierAgentId,
      eventType: 'PEER_VERIFY_DISPUTED',
      delta: DISPUTED_VERIFIER_DELTA,
      idempotencyKey: `peer_verify:${qid}:verifier_disputed`,
      metadata: {
        reason: 'verifier_disputed_claim',
        queue_id: qid,
        claim: claimRef,
      },
      certaintyAtClaim: input.certaintyAtClaim ?? undefined,
    });
    // Bridge the disputed-verifier slash to the ERC-8004 outbox (flag-gated,
    // best-effort). Snapshots the verifier's now-lower current_repid on-chain.
    if (slash) {
      await emitOnChainOutboxEvent({
        subjectAgentId: input.verifierAgentId,
        eventType: 'peer_verify_disputed',
        reputationDelta: DISPUTED_VERIFIER_DELTA,
        context: { queue_id: qid, role: 'verifier', claim: claimRef },
      });
    }

    return {
      emitted: !!slash,
      verifierEventId: slash?.id,
      verifierRepidAfter: slash?.repid_after ?? undefined,
    };
  }

  return { emitted: false };
}