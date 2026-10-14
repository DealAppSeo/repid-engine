/**
 * failed-receipt-settler.ts — score a server-settled FAILED receipt the actor never presents.
 * (2026-10-14, XC1's re-attack of #1364, finding 3, S1.)
 *
 * THE GAP. A confirmed outcome moved the score only when the ACTOR posted it to /score with the receipt
 * id. A VERIFIED receipt is a gain, so the actor posts it. A FAILED receipt is a confirmed wrong, so the
 * actor simply does not, and nothing else ever looked at it: an agent's wrongs were opt-in.
 *
 * THE FIX. This job finds FAILED receipts that are still unconsumed after a grace window (the actor had
 * its chance to present it), and applies each one to its SUBJECT through the SAME path the actor would
 * use: updateRepId with a confirmedOutcome naming the receipt. Everything that guards that path still
 * guards this one: the verifier (actor binding, SETTLED, non-simulated, objective settler, content key,
 * gate provenance, TTL) and the one-time claim (UPDATE … WHERE consumed_at IS NULL). The worker
 * chooses nothing the verifier does not re-check; it only supplies the presentation the actor withheld.
 *
 * IDEMPOTENT by construction. The receipt is consumed by the claim inside updateRepId, so a second run,
 * a concurrent run, or an actor presenting it at the same moment cannot apply it twice: exactly one
 * conditional claim wins, and the loser is an inert hold.
 *
 * MODE — CONFIRMED_FAILED_SETTLE_MODE (default off):
 *   off     nothing is scheduled and nothing is read.
 *   shadow  the query runs and every receipt that WOULD be applied is logged. Nothing is scored or consumed.
 *   enforce applies, BUT only while CONFIRMED_OUTCOME_SCORING_ENABLED is on. With that flag off,
 *           updateRepId ignores confirmedOutcome and would apply the vehicle event's fixed delta
 *           instead of the confirmed wrong, so the run refuses, loudly.
 * Knobs: CONFIRMED_FAILED_SETTLE_AFTER_HOURS (grace, default 24; must be under the receipt TTL, or no
 * receipt could ever qualify) and CONFIRMED_FAILED_SETTLE_MAX_PER_RUN (default 25). An unreadable knob
 * refuses the run rather than guessing: this job only ever subtracts reputation.
 */
import { db } from '../db';
import { resolveServerConfirmation, updateRepId } from '../engine/repid-update';
import { shouldParkForHalt } from './emergency-halt';
import { confirmedOutcomeScoringEnabled, confirmedReceiptTtlMs } from '../scoring/confirmed-outcome';
import type { RepIdEventType } from '../scoring/repid-deltas';

export type FailedSettleMode = 'off' | 'shadow' | 'enforce';

/**
 * The vehicle event type. With confirmed scoring on, the confirmed branch runs first and replaces its
 * delta, so the type only labels the audit row (metadata.confirmed_outcome.reason says confirmed_wrong).
 *
 * There is no clean choice today, and the options were read rather than guessed (2026-10-14):
 *   - it must be in the engine's RepIdEventType AND in the prod repid_score_events event_type CHECK;
 *   - VALIDATION_FAILED is in the CHECK but not in RepIdEventType;
 *   - UNSUPPORTED_CLAIM, PEER_VERIFY_WRONG_CALL and DEFENDED_* are in RepIdEventType but NOT the CHECK
 *     (the insert would fail);
 *   - EPISTEMIC_VIOLATION fits both, but computeRedemptionModifier counts it as a violation, so a
 *     settled wrong would also change the agent's redemption eligibility, which is a second effect.
 * CHALLENGE_LOSS fits both and has no scoring effect beyond its own delta, which is replaced. Its cost
 * is labelling: penalty-provenance reads it as `challenge_loss`. A dedicated event type
 * (e.g. CONFIRMED_WRONG) in both lists is the clean follow-up. That needs DDL on the CHECK.
 */
export const SETTLE_EVENT_TYPE: RepIdEventType = 'CHALLENGE_LOSS';
const INTERVAL_MS = 15 * 60 * 1000;

export function failedSettleMode(): FailedSettleMode {
  const m = (process.env['CONFIRMED_FAILED_SETTLE_MODE'] ?? '').trim().toLowerCase();
  return m === 'shadow' || m === 'enforce' ? m : 'off';
}

// Literal process.env['NAME'] reads at the call sites, so the env registry (and its typo guard) knows them.
function positiveNumber(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface SettleSummary {
  mode: FailedSettleMode;
  /** Set when the run did nothing on purpose (off, bad knob, scoring flag off, read error). */
  refused?: string;
  found: number;
  applied: Array<{ receiptId: string; agentId: string; delta: number }>;
  held: Array<{ receiptId: string; agentId: string; why: string }>;
}

let running = false;

/** One pass. Exported for tests and for an operator one-shot; never throws. */
export async function settleFailedReceiptsOnce(): Promise<SettleSummary> {
  const mode = failedSettleMode();
  const summary: SettleSummary = { mode, found: 0, applied: [], held: [] };
  if (mode === 'off') return { ...summary, refused: 'mode_off' };
  if (running) return { ...summary, refused: 'already_running' };
  running = true;
  try {
    const afterHours = positiveNumber(process.env['CONFIRMED_FAILED_SETTLE_AFTER_HOURS'], 24);
    const maxPerRun = positiveNumber(process.env['CONFIRMED_FAILED_SETTLE_MAX_PER_RUN'], 25);
    if (afterHours === null || maxPerRun === null || !Number.isInteger(maxPerRun)) {
      console.error('[failed-settle] REFUSED: CONFIRMED_FAILED_SETTLE_AFTER_HOURS / _MAX_PER_RUN is unreadable; nothing applied');
      return { ...summary, refused: 'bad_knob' };
    }
    let ttlMs: number;
    try {
      ttlMs = confirmedReceiptTtlMs();
    } catch (e) {
      console.error(`[failed-settle] REFUSED: receipt TTL unreadable (${e instanceof Error ? e.message : String(e)})`);
      return { ...summary, refused: 'bad_ttl' };
    }
    const graceMs = afterHours * 3_600_000;
    if (graceMs >= ttlMs) {
      console.error(
        `[failed-settle] REFUSED: grace ${afterHours}h is not under the receipt TTL ${ttlMs / 3_600_000}h, so no receipt could ever qualify`,
      );
      return { ...summary, refused: 'grace_not_under_ttl' };
    }
    // L0 gate 0.4 — the global emergency halt parks this worker like every other producer (the bridge,
    // the peer-verification reader). Nothing is lost: an unconsumed receipt is still there next tick.
    if (await shouldParkForHalt(db, 'FailedReceiptSettler')) {
      return { ...summary, refused: 'emergency_halt' };
    }
    if (mode === 'enforce' && !confirmedOutcomeScoringEnabled()) {
      console.error(
        '[failed-settle] REFUSED: enforce needs CONFIRMED_OUTCOME_SCORING_ENABLED=true. With it off, updateRepId would ' +
          `apply ${SETTLE_EVENT_TYPE}'s fixed delta instead of the confirmed wrong. Nothing applied.`,
      );
      return { ...summary, refused: 'confirmed_scoring_off' };
    }

    const now = Date.now();
    const { data, error } = await db
      .from('kernel_receipts')
      .select('receipt_id, subject_agent_id, settled_by, args_hash, created_at')
      .eq('verification_status', 'FAILED')
      .eq('verdict_label', 'SETTLED')
      .eq('is_simulated', false)
      .is('consumed_at', null)
      .in('settled_by', ['holdout', 'known_answer'])
      .lt('created_at', new Date(now - graceMs).toISOString())
      .gt('created_at', new Date(now - ttlMs).toISOString())
      .order('created_at', { ascending: true })
      .limit(maxPerRun);
    if (error || !Array.isArray(data)) {
      console.error(`[failed-settle] read failed, nothing applied: ${error?.message ?? 'no data'}`);
      return { ...summary, refused: 'read_failed' };
    }
    summary.found = data.length;

    // ONE WRONG PER CONTENT (XC1 review of #1371): two FAILED receipts for the same work (same subject +
    // args_hash) are one wrong. A duplicate inside this batch, or of content already settled, is skipped
    // here and left unspent; the partial unique index kernel_receipts_one_wrong_per_content
    // (migrations/2026-10-14-kernel-receipts-engine-signature.sql) is the atomic, cross-process backstop.
    const seenContent = new Set<string>();
    for (const row of data as Array<{ receipt_id: string; subject_agent_id: string; settled_by: 'holdout' | 'known_answer'; args_hash: string | null }>) {
      const receiptId = row.receipt_id;
      const agentId = row.subject_agent_id;
      const contentKey = typeof row.args_hash === 'string' ? `${agentId}|${row.args_hash}` : null;
      if (contentKey !== null) {
        if (seenContent.has(contentKey)) {
          summary.held.push({ receiptId, agentId, why: 'duplicate_content_in_run' });
          continue;
        }
        seenContent.add(contentKey);
        const prior = await db
          .from('kernel_receipts')
          .select('receipt_id')
          .eq('subject_agent_id', agentId)
          .eq('args_hash', row.args_hash)
          .eq('verification_status', 'FAILED')
          .not('consumed_at', 'is', null)
          .limit(1);
        if (prior.error || !Array.isArray(prior.data)) {
          summary.held.push({ receiptId, agentId, why: 'content_check_unreadable' }); // fail closed: never risk a second wrong
          continue;
        }
        if (prior.data.length > 0) {
          summary.held.push({ receiptId, agentId, why: 'content_already_settled' });
          continue;
        }
      }
      if (mode === 'shadow') {
        // SHADOW RUNS THE SAME GATE (read-only): it logs WOULD apply only for a receipt the verifier would
        // actually confirm as a wrong, so the shadow count is what enforce would do.
        const vc = await resolveServerConfirmation(agentId, receiptId);
        if (vc?.result === 'wrong') {
          console.warn(`[failed-settle] SHADOW: WOULD apply FAILED receipt ${receiptId} (settled_by ${row.settled_by}) to agent ${agentId}`);
          summary.held.push({ receiptId, agentId, why: 'shadow_would_apply' });
        } else {
          console.warn(`[failed-settle] SHADOW: would NOT apply receipt ${receiptId} to agent ${agentId}: the verifier does not confirm it`);
          summary.held.push({ receiptId, agentId, why: 'shadow_verifier_refuses' });
        }
        continue;
      }
      try {
        const out = await updateRepId({
          agentId,
          eventType: SETTLE_EVENT_TYPE,
          confirmedOutcome: { settledBy: row.settled_by, result: 'wrong', confirmationReceiptId: receiptId },
        });
        if (out.delta < 0) {
          summary.applied.push({ receiptId, agentId, delta: out.delta });
        } else {
          // The verifier or the claim refused it (already consumed by the actor or another run, not a gate
          // receipt, expired between the query and the call, …). The audit row records which.
          summary.held.push({ receiptId, agentId, why: `held_inert:${out.confirmedOutcome?.reason ?? 'no_confirmed_outcome'}` });
        }
      } catch (e) {
        summary.held.push({ receiptId, agentId, why: `error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    console.warn(
      `[failed-settle] ${mode}: found ${summary.found}, applied ${summary.applied.length}, held ${summary.held.length}` +
        (summary.applied.length ? ` — ${summary.applied.map((a) => `${a.receiptId}→${a.agentId} ${a.delta}`).join(', ')}` : ''),
    );
    return summary;
  } finally {
    running = false;
  }
}

/** Boot hook. OFF schedules nothing; the resolved mode is logged either way, so "off" is never silent. */
export function startFailedReceiptSettler(): void {
  const mode = failedSettleMode();
  console.log(`[failed-settle] CONFIRMED_FAILED_SETTLE_MODE=${mode} (default off; off|shadow|enforce)`);
  if (mode === 'off') return;
  setInterval(() => void settleFailedReceiptsOnce(), INTERVAL_MS);
}
