/**
 * On-chain outbox emitter (feat/verify-redteam-repid-erc8004, 2026-07-02).
 *
 * Bridges the RepID SCORE ledger (repid_score_events, moved by the DB trigger)
 * to the ERC-8004 OUTBOX (repid_events, polled by FeedbackLoopWorker). Peer-
 * verification and red-team adjudication already move current_repid via
 * repid_score_events; without an outbox row those movements never reach the
 * chain (the ~1,039 daily peer-verify runs + red-team catches that showed 0
 * on-chain writes in 24h). This helper writes the eligible repid_events row so
 * the worker's next poll picks it up and snapshots current_repid on-chain.
 *
 * Default-safe:
 *   - Gated behind VERIFY_REDTEAM_ONCHAIN_OUTBOX (default OFF). Zero behaviour
 *     change at merge; Sean flips the flag to activate the new outbox rows.
 *   - Never throws into the caller's happy path (score emission must not fail
 *     because the outbox insert failed). Returns {emitted:false} + logs loud.
 *   - Writes subject_type:'agent' + is_simulated so the worker's eligibility
 *     filter (isEligibleForOnChainWrite) accepts real rows and rejects sims.
 */
import { db } from '../db';
import type { OnChainEligibleEventType } from '../workers/feedback-loop-filters';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboxEmitInput {
  /** repid_agents.id (uuid) whose current_repid should be snapshotted on-chain. */
  subjectAgentId: string;
  eventType: OnChainEligibleEventType;
  /** The RepID delta already applied to the score ledger (recorded for audit). */
  reputationDelta: number;
  /** true when the source event is a simulation — carried so the worker skips it. */
  isSimulated?: boolean;
  /** Free-form context (queue_id, challenge_id, role, etc.). */
  context?: Record<string, unknown>;
}

export interface OutboxEmitResult {
  emitted: boolean;
  skippedReason?: 'flag_off' | 'invalid_subject' | 'insert_failed';
}

export function onchainOutboxEnabled(): boolean {
  return (process.env.VERIFY_REDTEAM_ONCHAIN_OUTBOX || 'false').toLowerCase() === 'true';
}

/**
 * Emit one eligible repid_events outbox row. Best-effort: returns emitted:false
 * (never throws) on flag-off, bad subject, or insert failure.
 */
export async function emitOnChainOutboxEvent(
  input: OutboxEmitInput
): Promise<OutboxEmitResult> {
  if (!onchainOutboxEnabled()) {
    return { emitted: false, skippedReason: 'flag_off' };
  }
  if (!input.subjectAgentId || !UUID_RE.test(input.subjectAgentId)) {
    // The worker filter would reject a non-uuid subject anyway; skip cleanly.
    console.warn(
      `[onchain-outbox] skipping ${input.eventType}: invalid subject_id ${String(input.subjectAgentId)}`
    );
    return { emitted: false, skippedReason: 'invalid_subject' };
  }

  try {
    const { error } = await db.from('repid_events').insert({
      subject_id: input.subjectAgentId,
      subject_type: 'agent',
      event_type: input.eventType,
      reputation_delta: input.reputationDelta,
      event_data: {
        // Non-mock hash; the worker overwrites reputation_tx_hash after the
        // real write. Absent a source tx, the worker default-fills a zero-hash
        // for the feedbackHash arg, so this only needs to pass the mock filter.
        tx_hash: null,
        is_simulated: input.isSimulated ?? false,
        source: 'verify-redteam-onchain-outbox',
        settled_at: new Date().toISOString(),
        ...(input.context ?? {}),
      },
    });
    if (error) {
      console.error(
        `[onchain-outbox] repid_events insert FAILED for ${input.eventType} subject=${input.subjectAgentId}:`,
        error.message ?? error
      );
      return { emitted: false, skippedReason: 'insert_failed' };
    }
    return { emitted: true };
  } catch (e: any) {
    console.error(
      `[onchain-outbox] unexpected error emitting ${input.eventType}:`,
      e?.message ?? e
    );
    return { emitted: false, skippedReason: 'insert_failed' };
  }
}
