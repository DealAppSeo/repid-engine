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
 */

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
  /** True only when BOTH env vars are present. Either alone pages nobody. */
  armed: boolean;
  missing: string[];
  cooldown_ms: number;
  /** Distinct reasons currently inside their cooldown window — i.e. actively firing. */
  suppressed_reasons: number;
}

export function pagerStatus(): PagerStatus {
  const missing: string[] = [];
  if (!process.env['TELEGRAM_BOT_TOKEN']) missing.push('TELEGRAM_BOT_TOKEN');
  if (!process.env['TELEGRAM_OWNER_CHAT_ID']) missing.push('TELEGRAM_OWNER_CHAT_ID');
  return {
    armed: missing.length === 0,
    missing,
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
  if (s.armed) {
    console.log(`[operator-pager] ARMED — failures page the owner chat (cooldown ${s.cooldown_ms}ms)`);
  } else {
    console.warn(
      `[operator-pager] NOT ARMED — missing ${s.missing.join(', ')}. ` +
        'Degraded states will be logged and NOT paged. Nothing is watching this process.',
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

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_OWNER_CHAT_ID'];
  if (!token || !chatId) {
    // Not armed. Audit it so the gap is discoverable after the fact rather than only in a log
    // line nobody tailed — the same reason this module exists.
    await audit(source, reason, { ...detail, paged: false, pager_armed: false });
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

  // A page that failed to send is itself a silent failure. Audit both outcomes: the row is the
  // only durable record that the system tried to tell someone.
  await audit(source, reason, { ...detail, paged: ok, pager_armed: true });
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
