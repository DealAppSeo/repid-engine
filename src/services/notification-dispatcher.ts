/**
 * Notification dispatcher.
 *
 * Builders set a preference at builders.notification_prefs.notify_on_resolve:
 *   { channel: 'webhook' | 'telegram' | 'console', destination: string }
 *
 * Channels:
 *   - webhook   : POST JSON to destination URL.
 *   - telegram  : sendTelegramAlert(...) via the existing telegram router
 *                 if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env are set;
 *                 otherwise falls back to console.
 *   - console   : default. Just logs.
 *
 * All failures are swallowed (notifications must not break the
 * resolution pipeline). A best-effort audit row is emitted on dispatch.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

export type NotificationChannel = 'webhook' | 'telegram' | 'console';

export interface NotificationPref {
  channel: NotificationChannel;
  destination: string;
}

export interface SetPrefResult {
  ok: boolean;
  channel?: NotificationChannel;
  error?: string;
}

const VALID_CHANNELS: NotificationChannel[] = ['webhook', 'telegram', 'console'];

export async function setBuilderNotificationPref(builderId: string, channel: NotificationChannel, destination: string): Promise<SetPrefResult> {
  if (!VALID_CHANNELS.includes(channel)) {
    return { ok: false, error: `unknown channel: ${channel}` };
  }
  if (typeof destination !== 'string' || destination.length > 1000) {
    return { ok: false, error: 'destination must be a string ≤ 1000 chars' };
  }
  if (channel === 'webhook' && !/^https?:\/\//i.test(destination)) {
    return { ok: false, error: 'webhook destination must be http(s) URL' };
  }

  const { data: builder } = await db
    .from('builders')
    .select('notification_prefs')
    .eq('id', builderId)
    .maybeSingle();
  const prefs = (builder?.notification_prefs as Record<string, any>) ?? {};
  prefs.notify_on_resolve = { channel, destination };

  const { error } = await db.from('builders').update({ notification_prefs: prefs }).eq('id', builderId);
  if (error) return { ok: false, error: error.message };

  await emitAuditEvent({
    event_type: 'notification_pref_set',
    source_table: 'builders',
    source_id: builderId,
    payload: { builder_id: builderId, channel, destination_kind: channel },
  });

  return { ok: true, channel };
}

export interface NotifyPayload {
  event_type: string;
  bet_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  pnl: number;
  pnl_pct: number;
  outcome: boolean;
  new_cap_pct?: number;
}

export async function dispatchNotificationFor(builderId: string, payload: NotifyPayload): Promise<{ delivered: boolean; channel?: NotificationChannel }> {
  const { data: builder } = await db
    .from('builders')
    .select('notification_prefs, email')
    .eq('id', builderId)
    .maybeSingle();
  const pref = (builder?.notification_prefs as any)?.notify_on_resolve as NotificationPref | undefined;
  const channel: NotificationChannel = pref?.channel ?? 'console';
  const destination = pref?.destination ?? '';

  const message = buildHumanMessage(payload);

  try {
    if (channel === 'webhook') {
      await fetch(destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, builder_id: builderId, summary: message }),
      } as any);
    } else if (channel === 'telegram') {
      try {
        const { sendTelegramAlert } = await import('../routes/telegram.js');
        await sendTelegramAlert(message);
      } catch (e: any) {
        console.log('[notify:telegram-fallback]', message);
      }
    } else {
      console.log(`[notify:console builder=${builderId}]`, message);
    }
  } catch (e: any) {
    console.warn('[notify] dispatch failed:', e?.message ?? 'unknown');
    return { delivered: false, channel };
  }

  await emitAuditEvent({
    event_type: 'notification_dispatched',
    source_table: 'builders',
    source_id: builderId,
    payload: { builder_id: builderId, channel, payload },
  });

  return { delivered: true, channel };
}

function buildHumanMessage(p: NotifyPayload): string {
  const verdict = p.outcome ? 'WIN' : 'LOSS';
  const pnlStr = p.pnl >= 0 ? `+${p.pnl.toFixed(2)}` : `${p.pnl.toFixed(2)}`;
  const pctStr = (p.pnl_pct * 100).toFixed(2);
  let out = `[paper-trade ${verdict}] ${p.side.toUpperCase()} ${p.symbol} → P&L ${pnlStr} (${pctStr}%) bet=${p.bet_id}`;
  if (p.new_cap_pct !== undefined) out += ` | new cap ${p.new_cap_pct}%`;
  return out;
}
