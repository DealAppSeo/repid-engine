import { db } from '../db';
import { pgQuery } from '../db/direct-pg';
import { sendTelegramMessage } from '../routes/telegram';

// V1.5 Slice-1 HITL notification dispatcher (CC2 2026-05-26).
//
// Watches trinity_hitl_requests for newly-created CAPABILITY_GAP rows and fans
// them out to subscribers in trinity_user_notification_prefs (telegram channel).
// Every send writes an audit row to notifications (including telegram_message_id
// for future V1.6 approve/deny round-trip correlation).
//
// NAMING: kept distinct from `notification-dispatcher.ts` (which handles a
// different system — per-builder paper-trade resolution notifications via
// builders.notification_prefs). The two services do not share state.
//
// SAFETY MODEL:
//   * Default OFF — only runs when NOTIFICATION_DISPATCHER_ENABLED === 'true'.
//   * "Mark-then-send" (not "send-then-mark") — we set notified_at as part of
//     the atomic claim, BEFORE sending Telegram. Trade-off: a Telegram failure
//     means the user misses that one notification (recorded with
//     delivery_status='failed' in notifications) instead of risking a duplicate
//     blast on retry. For V1 that's the right side of the tradeoff.
//   * Multi-instance-safe via FOR UPDATE SKIP LOCKED in the claim subquery.
//   * Initial 48h: requested_at filter limits to the last 60 minutes by default
//     (NOTIFICATION_LOOKBACK_MIN) so the 1,040-row backlog doesn't flood Sean's
//     Telegram on first enable. Lift to a large value once steady.
//
// SLICE-1 SCOPE (deferred to slice-2/V1.6):
//   * Telegram channel only.
//   * One event class: 'high_priority_capability_gap' (reason LIKE 'CAPABILITY_GAP%').
//   * One-way push only — no /approve /deny inbound.
//   * Per-agent-owner authorization is global-subscriber-only: a pref with
//     agent_id=NULL subscribes to all agents; a non-null agent_id targets one.

const POLL_INTERVAL_MS = parseInt(process.env.NOTIFICATION_POLL_INTERVAL_MS || '30000', 10);
const LOOKBACK_MIN = parseInt(process.env.NOTIFICATION_LOOKBACK_MIN || '60', 10);
const BATCH_LIMIT = parseInt(process.env.NOTIFICATION_BATCH_LIMIT || '20', 10);
const ENABLED = (): boolean => process.env.NOTIFICATION_DISPATCHER_ENABLED === 'true';

const EVENT_TYPE = 'high_priority_capability_gap';
// Sentinel for notifications.user_id when the matched pref identifies via
// sbt_token_id or device_token (notifications.user_id is NOT NULL uuid).
// Real identity is preserved in the data jsonb for traceability.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CONTROLLER_BASE = process.env.CONTROLLER_APP_URL || 'https://controller.aitrinitysymphony.com';

let isRunning = false;

interface ClaimedRow {
  id: string; // uuid
  agent_id: string;
  reason: string;
  task_id: number | null;
  context: unknown;
  requested_at: string;
}

interface PrefRow {
  id: number;
  user_id: string | null;
  sbt_token_id: string | null;
  device_token: string | null;
  channel_config: Record<string, any>;
  opt_in_event_types: string[];
  agent_id: string | null;
}

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderMessage(req: ClaimedRow): string {
  const tail = req.task_id ? ` · task ${req.task_id}` : '';
  return (
    `🚨 <b>Agent capability gap</b>\n` +
    `<code>${escapeHtml(req.agent_id)}</code>${tail}\n` +
    `${escapeHtml(req.reason)}\n` +
    `request: <code>${escapeHtml(req.id)}</code>\n` +
    `<a href="${CONTROLLER_BASE}/escalation/${encodeURIComponent(req.id)}">open</a>`
  );
}

export function classifyReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith('CAPABILITY_GAP')) return EVENT_TYPE;
  return null;
}

export async function startHitlNotificationDispatcher(): Promise<void> {
  if (!ENABLED()) {
    console.log(
      '[HitlNotificationDispatcher] disabled (NOTIFICATION_DISPATCHER_ENABLED != "true") — skipping start',
    );
    return;
  }
  console.log(
    `[HitlNotificationDispatcher] start · poll=${POLL_INTERVAL_MS}ms · lookback=${LOOKBACK_MIN}min · ` +
      `batch=${BATCH_LIMIT} · event=${EVENT_TYPE}`,
  );
  setInterval(pollOnce, POLL_INTERVAL_MS);
  // run once on boot so first deliveries don't wait a full interval
  pollOnce();
}

export async function pollOnce(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    // Atomic claim: lock matching rows + mark notified_at in one statement.
    // FOR UPDATE SKIP LOCKED keeps the claim safe across multiple server instances.
    const claimed = await pgQuery<ClaimedRow>(
      `UPDATE trinity_hitl_requests
         SET notified_at = now()
       WHERE id IN (
         SELECT id FROM trinity_hitl_requests
         WHERE status = 'pending'
           AND notified_at IS NULL
           AND reason LIKE 'CAPABILITY_GAP%'
           AND requested_at > NOW() - make_interval(mins => $1)
         ORDER BY requested_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, agent_id, reason, task_id, context, requested_at`,
      [LOOKBACK_MIN, BATCH_LIMIT],
      { label: 'hitl-notif-claim' },
    );

    if (claimed.length === 0) return;
    console.log(`[HitlNotificationDispatcher] claimed ${claimed.length} request(s)`);

    // One prefs lookup per cycle — slice-1 keeps it simple. Small table; trivial cost.
    const { data: prefData, error: prefErr } = await db
      .from('trinity_user_notification_prefs')
      .select('id,user_id,sbt_token_id,device_token,channel_config,opt_in_event_types,agent_id')
      .eq('active', true)
      .eq('notification_channel', 'telegram')
      .contains('opt_in_event_types', [EVENT_TYPE]);

    if (prefErr) {
      console.error('[HitlNotificationDispatcher] prefs lookup error:', prefErr.message);
      return;
    }
    const allPrefs: PrefRow[] = (prefData ?? []) as PrefRow[];

    for (const req of claimed) {
      const eventType = classifyReason(req.reason) ?? EVENT_TYPE;
      // Match: pref.agent_id null = "subscribe to all agents"; non-null = "this agent only"
      const matching = allPrefs.filter((p) => p.agent_id == null || p.agent_id === req.agent_id);
      const msg = renderMessage(req);

      if (matching.length === 0) {
        // No subscriber → audit-only entry (so the empty case is observable)
        await db.from('notifications').insert({
          user_id: NIL_UUID,
          type: eventType,
          title: `No subscribers for ${eventType}`,
          message: msg,
          data: {
            request_id: req.id,
            agent_id: req.agent_id,
            reason: req.reason,
            delivery_status: 'no_subscriber',
          },
        });
        continue;
      }

      for (const p of matching) {
        const chatId = (p.channel_config ?? {}).chat_id;
        if (!chatId) {
          await db.from('notifications').insert({
            user_id: p.user_id ?? NIL_UUID,
            type: eventType,
            title: `Pref ${p.id} missing telegram chat_id`,
            message: msg,
            data: {
              request_id: req.id,
              agent_id: req.agent_id,
              channel: 'telegram',
              channel_pref_id: p.id,
              delivery_status: 'misconfigured',
            },
          });
          continue;
        }

        const send = await sendTelegramMessage(String(chatId), msg);
        await db.from('notifications').insert({
          user_id: p.user_id ?? NIL_UUID,
          type: eventType,
          title: `Agent ${req.agent_id}: ${eventType.replace(/_/g, ' ')}`,
          message: msg,
          data: {
            request_id: req.id,
            agent_id: req.agent_id,
            reason: req.reason,
            channel: 'telegram',
            channel_pref_id: p.id,
            sbt_token_id: p.sbt_token_id ?? null,
            device_token: p.device_token ?? null,
            telegram_message_id: send.message_id ?? null,
            delivery_status: send.ok ? 'sent' : 'failed',
            tg_error: send.error ?? null,
          },
        });
      }
    }
  } catch (e: any) {
    console.error('[HitlNotificationDispatcher] poll error:', e?.message ?? e);
  } finally {
    isRunning = false;
  }
}
