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
 * ONE WRONG PER SIGNED RECEIPT, VERIFIER FIRST (2026-10-14, XC1 review of #1374). Each row is first run
 * through the same read-only decision updateRepId makes (previewSettledWrong: actor binding, engine
 * signature, sealed body, TTL, price). Only a row that passes is applied or counted; a row that fails
 * neither applies nor blocks anything. There is NO content-level dedupe for wrongs any more: it keyed on
 * unsigned columns (subject|args_hash) before the signature was checked, so a service-role decoy row
 * (unsigned, or pre-consumed) suppressed a real signed wrong, and args_hash is client-chosen, so "one
 * wrong per content" never meant one wrong per piece of work. Each signed FAILED receipt is a distinct
 * kernel decision and is spent once, by receipt_id. The MAX_PER_RUN cap counts ACCEPTED rows, and the
 * scan reads past refused ones (up to SCAN_FACTOR × the cap), so a batch of decoys cannot starve it.
 * Shadow and enforce make the same decision on the same rows: the shadow count is what enforce applies.
 *
 * RESIDUAL (stated, not closed here): a writer that can UPDATE kernel_receipts can still mark the real
 * receipt consumed, or delete it, and the settler never sees it. The signature makes a forgery fail;
 * it cannot make a row exist. Detecting that needs an audit of consumed FAILED receipts against the
 * repid_score_events row that spent each one.
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
import { previewSettledWrong, updateRepId } from '../engine/repid-update';
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
/**
 * Rows read per run = SCAN_FACTOR × MAX_PER_RUN, so refused rows in front cannot starve a signed wrong.
 * ponytail: one bounded read, not pagination. A window holding more refused rows than this is logged
 * LOUDLY every run (scan_ceiling); page by (created_at, receipt_id) if that ever fires for real.
 */
const SCAN_FACTOR = 20;

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
  /** Rows the verifier would apply (enforce attempts them; shadow logs them). Capped at MAX_PER_RUN. */
  accepted: number;
  applied: Array<{ receiptId: string; agentId: string; delta: number }>;
  held: Array<{ receiptId: string; agentId: string; why: string }>;
  /** True when the scan read its whole SCAN_FACTOR × MAX_PER_RUN budget without filling the cap (logged loudly). */
  scanCeiling?: true;
}

let running = false;

/** One pass. Exported for tests and for an operator one-shot; never throws. */
export async function settleFailedReceiptsOnce(): Promise<SettleSummary> {
  const mode = failedSettleMode();
  const summary: SettleSummary = { mode, found: 0, accepted: 0, applied: [], held: [] };
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
    const scanLimit = maxPerRun * SCAN_FACTOR;
    const { data, error } = await db
      .from('kernel_receipts')
      .select('receipt_id, subject_agent_id, settled_by, created_at')
      .eq('verification_status', 'FAILED')
      .eq('verdict_label', 'SETTLED')
      .eq('is_simulated', false)
      .is('consumed_at', null)
      .in('settled_by', ['holdout', 'known_answer'])
      .lt('created_at', new Date(now - graceMs).toISOString())
      .gt('created_at', new Date(now - ttlMs).toISOString())
      .order('created_at', { ascending: true })
      .limit(scanLimit);
    if (error || !Array.isArray(data)) {
      console.error(`[failed-settle] read failed, nothing applied: ${error?.message ?? 'no data'}`);
      return { ...summary, refused: 'read_failed' };
    }
    summary.found = data.length;

    // VERIFIER FIRST, ONE WRONG PER SIGNED RECEIPT (see the header). Nothing is keyed on an unsigned
    // column: a row either passes the same decision updateRepId makes, or it is refused and blocks nothing.
    for (const row of data as Array<{ receipt_id: string; subject_agent_id: string; settled_by: 'holdout' | 'known_answer' }>) {
      if (summary.accepted >= maxPerRun) break;
      const receiptId = row.receipt_id;
      const agentId = row.subject_agent_id;
      const decision = await previewSettledWrong(agentId, receiptId, row.settled_by);
      if (!decision.wouldApply) {
        summary.held.push({ receiptId, agentId, why: `verifier_refuses:${decision.reason}` });
        continue;
      }
      summary.accepted++;
      if (mode === 'shadow') {
        console.warn(`[failed-settle] SHADOW: WOULD apply FAILED receipt ${receiptId} (settled_by ${row.settled_by}) to agent ${agentId}: ${decision.delta}`);
        summary.held.push({ receiptId, agentId, why: 'shadow_would_apply' });
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
          // Lost the claim to a concurrent spend of this receipt_id (the actor, another run), or the row
          // changed between the preview and the call. The audit row records which.
          summary.held.push({ receiptId, agentId, why: `held_inert:${out.confirmedOutcome?.reason ?? 'no_confirmed_outcome'}` });
        }
      } catch (e) {
        summary.held.push({ receiptId, agentId, why: `error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const refusedRows = summary.held.filter((h) => h.why.startsWith('verifier_refuses:')).length;
    if (data.length === scanLimit && summary.accepted < maxPerRun) {
      summary.scanCeiling = true;
      console.error(
        `[failed-settle] SCAN CEILING: read ${scanLimit} candidate FAILED receipts, ${refusedRows} refused by the verifier; ` +
          'signed wrongs may be waiting behind them. Investigate the refused rows (decoys?).',
      );
    }
    console.warn(
      `[failed-settle] ${mode}: found ${summary.found}, accepted ${summary.accepted}, refused ${refusedRows}, ` +
        `applied ${summary.applied.length}, held ${summary.held.length}` +
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
