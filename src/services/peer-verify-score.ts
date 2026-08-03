/**
 * Emit RepID score events after a real peer-verification verdict (Veritas path).
 * Uses pgQuery so apply_repid_score_event trigger applies current_repid in-process.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITER #12, AND IT HAS NEVER WRITTEN A ROW.
 *
 * #326 listed this file as the writer its supabase-js-shaped ratchet cannot see,
 * and judged it "behaviourally safe ... would 500 on a zero delta". The first half
 * is right for the wrong reason and the second half understates it: this writer
 * 500s on EVERY delta. Verified against prod 2026-08-03 in rolled-back
 * transactions, there are TWO independent, unconditional failures:
 *
 *   1. `ON CONFLICT (idempotency_key)` does not resolve an arbiter.
 *      There is NO plain unique constraint on the column. There are only two
 *      PARTIAL unique indexes (`uq_score_events_idempotency_key WHERE
 *      idempotency_key IS NOT NULL` and `repid_score_events_idempotency_
 *      peer_verify_uq WHERE idempotency_key ~~ 'peer_verify:%'`), and a partial
 *      index can only arbitrate when the statement repeats its predicate. So:
 *          ERROR 42P10: there is no unique or exclusion constraint matching
 *                       the ON CONFLICT specification
 *      This aborts the statement before the row is ever built.
 *
 *   2. The event types are not in the CHECK whitelist.
 *      `repid_score_events_event_type_check` enumerates 36 literals. Neither
 *      `PEER_VERIFY_VERIFIED` nor `PEER_VERIFY_DISPUTED` is among them:
 *          ERROR 23514: new row ... violates check constraint
 *                       "repid_score_events_event_type_check"
 *
 * The ledger agrees: **0 rows** with `event_type LIKE 'PEER_VERIFY%'` and **0**
 * with `idempotency_key LIKE 'peer_verify:%'`, out of 152,084 total rows. It went
 * unnoticed because the only caller (`src/routes/peer-verification.ts:389`)
 * catches the throw and downgrades it to `console.warn`, and because
 * `tests/peer-verify-score.test.ts` mocks `pgQuery` and hands back synthetic
 * success rows — so the suite is green over a path that cannot execute.
 *
 * WHAT THIS FILE DOES AND DOES NOT FIX. The guarded branch below removes cause 1
 * (the helper's supabase-js insert has no ON CONFLICT clause) and makes the
 * applier explicit. Cause 2 is a CHECK-constraint change under `migrations/`,
 * which this lane does not own — so enforce mode ALONE does not revive scoring
 * here, by design. Reviving it needs BOTH the flag and that migration, and that
 * combination starts moving RepID that has never moved. It is a live change and
 * it is Sean's call, not this lane's.
 *
 * THE APPLIER. This writer never touches `current_repid`, so
 * `trg_apply_repid_score_event` is the sole applier and there is no double-apply
 * on any ordering — that part of #326's read is confirmed. Hence
 * `applier: 'trigger'`, which is the honest declaration of what already happens.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { pgQuery } from '../db/direct-pg';
import { emitOnChainOutboxEvent } from './onchain-outbox';
import { scoreEventGuardEnforced } from '../routes/score-event-guard';
import { insertScoreEvent as insertGuardedScoreEvent } from '../scoring/score-event-writer';

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

interface ScoreEventRow {
  id: number;
  repid_after: number | null;
  repid_delta_applied: number | null;
}

interface InsertParams {
  agentId: string;
  eventType: string;
  delta: number;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  certaintyAtClaim?: number | null;
}

/**
 * The original raw-SQL insert, byte-identical. Reached whenever
 * `SCORE_EVENT_GUARD_MODE` is not `enforce`, i.e. by default.
 *
 * Kept rather than deleted for the reason `score-event-guard.ts` gives: the
 * allow-list in `tests/score-event-writer-ratchet.test.ts` asserts it has no
 * STALE entries, so removing the raw form has to happen in the same commit that
 * shrinks that list. See also the 42P10 / 23514 note at the top of this file —
 * this branch cannot currently insert anything.
 */
async function insertScoreEventLegacy(params: InsertParams): Promise<ScoreEventRow | null> {
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

/**
 * Enforce-mode insert: one explicit trigger-applier write through
 * `src/scoring/score-event-writer.ts`.
 *
 * Two things the helper cannot do that the legacy statement expressed, both
 * restored here so the guarded path keeps the same contract:
 *   - idempotency. `ON CONFLICT DO NOTHING` returned no row for a replay, which
 *     the callers read as "already emitted, do not re-bridge to the outbox". The
 *     helper's `.insert().select().single()` would raise 23505 instead, so the
 *     replay is checked first. (Pre-check + insert is not atomic; the partial
 *     unique index is still the real backstop, and a loser now surfaces as a
 *     logged failure rather than a duplicate row.)
 *   - `repid_after`. The helper returns only `id`, so the trigger-stamped value
 *     is read back — it is what the caller logs.
 */
async function insertScoreEventGuarded(params: InsertParams): Promise<ScoreEventRow | null> {
  const existing = await pgQuery<{ id: number }>(
    `SELECT id FROM repid_score_events WHERE idempotency_key = $1 LIMIT 1`,
    [params.idempotencyKey],
    { label: 'peer-verify-score-idempotency-check' }
  );
  if (existing[0]) return null;

  const res = await insertGuardedScoreEvent({
    applier: 'trigger',
    agent_id: params.agentId,
    event_type: params.eventType,
    delta: params.delta,
    idempotency_key: params.idempotencyKey,
    metadata: params.metadata,
    ...(params.certaintyAtClaim == null
      ? {}
      : { extra: { certainty_at_claim: params.certaintyAtClaim } }),
  });

  if (!res.ok) {
    // Fail loud. The historical failure of this writer was invisible precisely
    // because its only caller downgraded a throw to console.warn.
    console.error(
      `[peer-verify-score] guarded insert FAILED (${params.eventType}, ` +
        `key=${params.idempotencyKey}): ${res.error}`
    );
    return null;
  }

  const back = await pgQuery<ScoreEventRow>(
    `SELECT id, repid_after, repid_delta_applied FROM repid_score_events WHERE id = $1`,
    [res.id],
    { label: 'peer-verify-score-readback' }
  );
  return back[0] ?? null;
}

async function insertScoreEvent(params: InsertParams): Promise<ScoreEventRow | null> {
  // Zero delta is unwritable on BOTH branches, so this refusal is score-neutral
  // and therefore not flag-gated. `trg_apply_repid_score_event` early-returns at
  // `IF v_delta = 0` *before* stamping `repid_before`/`repid_after`, and both are
  // NOT NULL with no default, so the insert aborts:
  //     ERROR 23502: null value in column "repid_before" ... violates not-null
  // Probed on prod and rolled back. No row lands and no score moves either way —
  // the only change is a named log line instead of an opaque 500. Reachable via
  // PEER_VERIFY_VERIFIED_DELTA / PEER_VERIFY_DISPUTED_DELTA being set to 0.
  if (Math.round(params.delta) === 0) {
    console.error(
      `[peer-verify-score] refusing zero-delta score event (${params.eventType}, ` +
        `key=${params.idempotencyKey}): the applier trigger stands down at delta 0 and ` +
        `repid_before/repid_after are NOT NULL, so this insert cannot succeed (23502). ` +
        `Check PEER_VERIFY_VERIFIED_DELTA / PEER_VERIFY_DISPUTED_DELTA.`
    );
    return null;
  }

  return scoreEventGuardEnforced()
    ? insertScoreEventGuarded(params)
    : insertScoreEventLegacy(params);
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