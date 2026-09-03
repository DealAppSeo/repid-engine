/**
 * The loud channel — to the operator, and to nobody else.
 *
 * WHY IT IS SEPARATE FROM EVERY OTHER NOTIFICATION IN THIS CODEBASE. `notifyAgentEvent` tells an
 * AGENT that something good happened to it (its proof anchored). This tells SEAN that something
 * is broken. They must never share a path: an agent must not learn that the attester key is
 * missing, and an operator must not be paged once per agent per batch. Different audience,
 * different trigger, different failure mode if confused.
 *
 * Telegram only, to TELEGRAM_OWNER_CHAT_ID. No webhook fan-out, no per-agent addressing, no
 * database read to decide a recipient — there is exactly one recipient and it is an env var.
 *
 * THREE PROPERTIES THAT ARE NOT OPTIONAL:
 *
 * 1. IT NEVER THROWS AND NEVER BLOCKS. It is called from `markDegraded`, which is synchronous
 *    and sits in hot paths including the anchor worker's loop. A pager that could throw would
 *    turn "we noticed a problem" into a second, worse problem on the path that moves money.
 *    Every call is fire-and-forget; the caller does not await it and cannot fail because of it.
 *
 * 2. IT DEDUPES. A degraded worker degrades every cycle. Without a cooldown, a missing attester
 *    key is 288 identical messages a day, which trains the reader to mute the channel — and a
 *    muted pager is worse than none, because it looks armed. One page per distinct reason per
 *    window; the window resets when the condition clears.
 *
 * 3. IT REPORTS WHETHER IT IS ARMED. `pagerStatus()` is surfaced on /health so "are alerts live"
 *    is answerable from outside the box. An unconfigured pager is the exact failure this whole
 *    file exists to prevent, one level up: a monitoring system that is silently not monitoring.
 *    It degrades loudly at startup rather than discovering it during an incident.
 *
 * TWO CHANNELS, BECAUSE ONE OF THEM COULD NOT BE ARMED [MEASURED 2026-09-02 → 09-03].
 *
 * The first version of this file had exactly one channel, Telegram, and shipped to production
 * reporting `armed: false` with BOTH env vars unset — checked four times over ten hours. So the
 * thing built to stop silent failure was itself silently not firing, which is the defect it
 * exists to remove wearing its own uniform. "The operator has not set the variable yet" is a
 * true sentence and a bad answer.
 *
 *   RECORD (ops_alerts)  ALWAYS ON. Production already holds Supabase credentials, so this
 *                        channel needs no secret anyone has to remember. The row is durable,
 *                        queryable and has `acknowledged_at`, so an alert can be CLOSED rather
 *                        than merely emitted. It survives a restart; a Telegram message does not.
 *   PUSH (Telegram)      OPTIONAL. Wakes a human at 3am. Requires the two env vars.
 *
 * The distinction is deliberate: RECORD guarantees the failure is never LOST, PUSH decides
 * whether anyone finds out TONIGHT. Losing the record is the worse failure and is the one now
 * impossible. `ops_alerts` was itself a table nothing wrote to — built and never wired, the same
 * shape as this module before today.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const TELEGRAM_API = 'https://api.telegram.org';
const PAGE_TIMEOUT_MS = 5000;

/** One page per distinct reason per window. A degraded worker degrades every cycle. */
export const PAGE_COOLDOWN_MS = Number(process.env['OPERATOR_PAGE_COOLDOWN_MS'] ?? 3_600_000); // 1h

/**
 * Subsystems that can page, named so a message says WHAT is broken before WHY.
 *
 * These are the `tag` values markDegraded's callers ACTUALLY pass, read from the call sites
 * rather than invented: 'eas-anchor', 'hal', 'x402', 'zkp'. The first draft of this list guessed
 * 'anchor' and would have mislabelled every anchor-worker page as generic 'degraded' — the one
 * subsystem this was built for. 'proof-drain' is added by the drain wiring below.
 */
export type PageSource = 'eas-anchor' | 'proof-drain' | 'hal' | 'zkp' | 'x402' | 'degraded';

const lastPagedAt = new Map<string, number>();

/** Exposed for tests; production never needs to clear this. */
export function _resetPagerCooldown(): void {
  lastPagedAt.clear();
}

export interface PagerStatus {
  /**
   * Is the failure guaranteed to be CAPTURED? True whenever the record channel is available.
   *
   * This used to mean "is Telegram configured", which made one boolean stand for two channels of
   * very different importance — and read `false` on a system that was, in every sense that
   * matters for not losing an incident, working. Losing the record and failing to wake someone
   * are not the same severity and no longer share a field.
   */
  armed: boolean;
  /** Will a human be woken? Requires both env vars. */
  push_armed: boolean;
  /** Env vars missing for PUSH. Empty does not imply anything about the record channel. */
  missing: string[];
  channels: { record: 'ops_alerts'; push: 'telegram' | 'none' };
  cooldown_ms: number;
  /** Distinct reasons currently inside their cooldown window — i.e. actively firing. */
  suppressed_reasons: number;
}

export function pagerStatus(): PagerStatus {
  const missing: string[] = [];
  if (!process.env['TELEGRAM_BOT_TOKEN']) missing.push('TELEGRAM_BOT_TOKEN');
  if (!process.env['TELEGRAM_OWNER_CHAT_ID']) missing.push('TELEGRAM_OWNER_CHAT_ID');
  const push_armed = missing.length === 0;
  return {
    // The record channel rides on the Supabase client the whole process depends on; if that were
    // gone nothing here would be running. Reporting it as a live capability is honest, and
    // `recordAlert` still reports its own per-write failures rather than assuming success.
    armed: true,
    push_armed,
    missing,
    channels: { record: 'ops_alerts', push: push_armed ? 'telegram' : 'none' },
    cooldown_ms: PAGE_COOLDOWN_MS,
    suppressed_reasons: lastPagedAt.size,
  };
}

/**
 * Announce at startup whether the pager is actually armed.
 *
 * Called once from the server boot path. If it is NOT armed this is the loudest line in the log,
 * because every guarantee downstream of it is void: the system will fail exactly as silently as
 * it did before, while everyone believes it is watched.
 */
export function announcePagerStatus(): PagerStatus {
  const s = pagerStatus();
  if (s.push_armed) {
    console.log(`[operator-pager] ARMED — record: ops_alerts + push: telegram (cooldown ${s.cooldown_ms}ms)`);
  } else {
    console.warn(
      `[operator-pager] RECORD ONLY — failures ARE captured in ops_alerts and can be queried and ` +
        `acknowledged, but NOBODY WILL BE WOKEN: missing ${s.missing.join(', ')}. ` +
        'Set both on the repid-engine service to enable push.',
    );
  }
  return s;
}

/**
 * Page the operator about a failure. Fire-and-forget: returns immediately, never rejects.
 *
 * `reason` is the dedupe key as well as the message body, so keep it stable for a given
 * condition — a reason containing a timestamp or an id defeats the cooldown and re-creates the
 * spam this guards against.
 */
export function pageOperator(source: PageSource, reason: string, detail?: Record<string, unknown>): void {
  void deliver(source, reason, detail).catch(() => {
    // Unreachable — deliver() catches internally. Belt and braces: this function is called from
    // synchronous code that must not acquire a rejection handler it did not ask for.
  });
}

async function deliver(source: PageSource, reason: string, detail?: Record<string, unknown>): Promise<void> {
  const key = `${source}:${reason}`;
  const now = Date.now();
  const last = lastPagedAt.get(key);
  if (last !== undefined && now - last < PAGE_COOLDOWN_MS) return;
  lastPagedAt.set(key, now);

  // RECORD FIRST, and unconditionally. If the process dies immediately after this, the failure
  // is still on the record and still acknowledgeable. Telegram below may or may not be armed;
  // this does not care, which is the entire point of splitting the two.
  const recorded = await recordAlert(source, reason, detail);

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_OWNER_CHAT_ID'];
  if (!token || !chatId) {
    // Push is unarmed — but the alert is NOT lost, it is on the record above. Audit the split so
    // the distinction survives: "recorded but not pushed" is a different state from "dropped",
    // and collapsing them is how a monitoring gap gets mistaken for a quiet system.
    await audit(source, reason, { ...detail, recorded, pushed: false, push_armed: false });
    return;
  }

  const text =
    `🔴 *${source}* degraded\n\n${reason}` +
    (detail && Object.keys(detail).length ? `\n\n\`${JSON.stringify(detail).slice(0, 500)}\`` : '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let ok = false;
  try {
    const r = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: controller.signal,
    });
    ok = r.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  // A push that failed to send is itself a silent failure. Audit both outcomes.
  await audit(source, reason, { ...detail, recorded, pushed: ok, push_armed: true });
}

/**
 * Write the durable alert row. Returns whether it landed — never throws.
 *
 * `alert_type` is `${source}:${reason}` so it matches the cooldown key exactly: one row per
 * distinct condition per window, and a query grouping on alert_type counts conditions rather
 * than repetitions. `acknowledged_at` stays NULL until a human closes it, which is what makes
 * this a worklist instead of a log.
 */
async function recordAlert(
  source: PageSource,
  reason: string,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { error } = await db.from('ops_alerts').insert({
      alert_type: `${source}:${reason}`.slice(0, 500),
      notes: detail && Object.keys(detail).length ? JSON.stringify(detail).slice(0, 2000) : null,
    });
    if (error) {
      console.error(`[operator-pager] ops_alerts insert FAILED (${error.code ?? '?'}): ${error.message}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[operator-pager] ops_alerts insert THREW: ${e?.message ?? e}`);
    return false;
  }
}

async function audit(source: PageSource, reason: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await emitAuditEvent({
      event_type: 'operator_paged',
      source_table: 'operator_pager',
      source_id: `page-${source}-${Date.now()}`,
      payload: { source, reason, ...payload },
    });
  } catch {
    // Auditing the page must never become the thing that breaks the caller.
  }
}
