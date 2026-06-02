import crypto from 'crypto';
import type { Request, Response } from 'express';
import { db } from '../db';
import { pgQuery } from '../db/direct-pg';

// V1.6 — Telegram inline-keyboard approve/deny return loop (CC2 2026-05-27).
// Design spec: E:\dev\reports\2026-05-26\CC2_V16_DESIGN.md
//
// HMAC-signed callback_data format (33 bytes — under Telegram's 64-byte cap):
//   v1:<a|d>:<short_id_8hex>:<exp_unix_seconds>:<hmac_8hex>
// where hmac = HMAC_SHA256(HITL_CALLBACK_HMAC_SECRET, "v1:<dec>:<short>:<exp>").slice(0,8)
//
// Boot semantics: V1.6 is fully gated. The dispatcher only attaches buttons when
// HITL_CALLBACK_ENABLED='true' AND HITL_CALLBACK_HMAC_SECRET is set. The webhook
// branch only fires when callback_query arrives (so V1.5 slice-1 traffic with no
// keyboards is unaffected — no callbacks can arrive). Existing /webhook message
// handler is unchanged.

const HMAC_LEN = 8; // hex chars at the end of the payload
const PAYLOAD_REGEX = /^v1:([ad]):([0-9a-f]{8}):(\d{10}):([0-9a-f]{8})$/;

function getSecret(): string { return process.env.HITL_CALLBACK_HMAC_SECRET || ''; }

export interface ParsedCallback {
  ok: boolean;
  decision?: 'a' | 'd';
  requestIdShort?: string;
  exp?: number;
  error?: string;
}

export function signCallbackPayload(decision: 'a' | 'd', shortId: string, expSec: number): string {
  const secret = getSecret();
  if (!secret) throw new Error('HITL_CALLBACK_HMAC_SECRET not configured');
  if (!/^[0-9a-f]{8}$/.test(shortId)) throw new Error('shortId must be 8 lowercase hex chars');
  if (!Number.isInteger(expSec) || expSec < 1_000_000_000 || expSec > 9_999_999_999) {
    throw new Error('exp must be a 10-digit unix-seconds timestamp');
  }
  const base = `v1:${decision}:${shortId}:${expSec}`;
  const hmac = crypto.createHmac('sha256', secret).update(base).digest('hex').slice(0, HMAC_LEN);
  return `${base}:${hmac}`;
}

export function verifyCallbackPayload(data: string): ParsedCallback {
  const secret = getSecret();
  if (!secret) return { ok: false, error: 'HITL_CALLBACK_HMAC_SECRET not configured' };
  const m = PAYLOAD_REGEX.exec(data || '');
  if (!m) return { ok: false, error: 'malformed payload' };
  const [, decision, shortId, expStr, hmacGiven] = m as unknown as [string, 'a' | 'd', string, string, string];
  const base = `v1:${decision}:${shortId}:${expStr}`;
  const hmacExpected = crypto.createHmac('sha256', secret).update(base).digest('hex').slice(0, HMAC_LEN);
  const a = Buffer.from(hmacGiven, 'hex');
  const b = Buffer.from(hmacExpected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid hmac' };
  }
  return { ok: true, decision, requestIdShort: shortId, exp: parseInt(expStr, 10) };
}

// Compute the 8-hex short_id used in callback_data, from a full uuid.
export function shortIdFromUuid(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toLowerCase();
}

interface ResolvedRow {
  request_id: string;
  agent_id: string;
  task_id: number | null;
  reason: string;
  status: string;
  expected_chat_id: string | null;
}

async function answerCallback(callbackId: string, text: string, alert: boolean): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: alert }),
    });
  } catch { /* best-effort ack */ }
}

async function editMessageRemoveKeyboard(chatId: string, messageId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
  } catch { /* best-effort */ }
}

// Handler — invoked from the /api/v1/telegram/webhook branch when req.body.callback_query is present.
// Always replies 200 to Telegram (Telegram retries on 5xx; we don't want retry storms on internal errors).
export async function handleHitlCallback(req: Request, res: Response): Promise<void> {
  const cb = (req.body as any)?.callback_query;
  if (!cb) { res.sendStatus(200); return; }

  const callbackId: string = String(cb.id ?? '');
  const userChatId: string = String(cb.message?.chat?.id ?? '');
  const messageId: number = Number(cb.message?.message_id ?? 0);
  const dataStr: string = String(cb.data ?? '');

  try {
    // 1. parse + HMAC verify
    const parsed = verifyCallbackPayload(dataStr);
    if (!parsed.ok) {
      await answerCallback(callbackId, `Rejected: ${parsed.error}`, true);
      res.sendStatus(200);
      return;
    }
    const { decision, requestIdShort, exp } = parsed as Required<ParsedCallback>;

    // 2. expiry check (do BEFORE the DB hop; cheap)
    if (Math.floor(Date.now() / 1000) > exp) {
      await answerCallback(callbackId, 'This request expired (24h TTL). See the controller for batch triage.', true);
      // Best-effort: flip pending→expired in DB so the sweeper doesn't have to.
      // Resolve short_id first (the row may not exist if the request was deleted).
      try {
        await pgQuery(
          `UPDATE trinity_hitl_requests
             SET status='expired', resolved_at=now(), resolved_by='system:click-after-expiry'
           WHERE id::text LIKE $1 AND status='pending'`,
          [requestIdShort + '%'],
          { label: 'v16-click-expired' },
        );
      } catch { /* best-effort */ }
      res.sendStatus(200);
      return;
    }

    // 3. resolve short_id → full uuid + chat-id binding (single joined query)
    const rows = await pgQuery<ResolvedRow>(
      `SELECT r.id::text AS request_id, r.agent_id, r.task_id, r.reason, r.status,
              (p.channel_config->>'chat_id') AS expected_chat_id
         FROM trinity_hitl_requests r
         LEFT JOIN LATERAL (
           SELECT (n.data->>'channel_pref_id') AS pref_id
             FROM notifications n
            WHERE (n.data->>'request_id') = r.id::text
              AND (n.data->>'channel') = 'telegram'
              AND (n.data->>'delivery_status') = 'sent'
            ORDER BY n.created_at DESC
            LIMIT 1
         ) n ON true
         LEFT JOIN trinity_user_notification_prefs p ON p.id::text = n.pref_id
        WHERE r.id::text LIKE $1
        LIMIT 2`,
      [requestIdShort + '%'],
      { label: 'v16-resolve+bind' },
    );

    if (rows.length === 0) {
      await answerCallback(callbackId, 'Request not found', true);
      res.sendStatus(200);
      return;
    }
    if (rows.length > 1) {
      await answerCallback(callbackId, 'Ambiguous request id — open in controller', true);
      res.sendStatus(200);
      return;
    }
    const row = rows[0] as ResolvedRow;

    // 4. chat-id binding — prevents cross-chat impersonation
    if (!row.expected_chat_id || row.expected_chat_id !== userChatId) {
      await answerCallback(callbackId, 'Not authorized for this chat', true);
      res.sendStatus(200);
      return;
    }

    // 5. atomic state transition — first click wins; second matches 0 rows
    const newStatus = decision === 'a' ? 'approved' : 'denied';
    const upperDecision = decision === 'a' ? 'APPROVED' : 'DENIED';
    const updated = await pgQuery<{ id: string; status: string }>(
      `UPDATE trinity_hitl_requests
          SET status = $1,
              resolved_at = now(),
              resolved_by = $2,
              decision_metadata = coalesce(decision_metadata,'{}'::jsonb) || jsonb_build_object(
                'channel','telegram',
                'callback_message_id', $3::bigint,
                'click_at', now()::text,
                'decided_by_chat_id', $4
              )
        WHERE id::text = $5 AND status = 'pending'
        RETURNING id::text AS id, status`,
      [newStatus, `tg:${userChatId}`, messageId, userChatId, row.request_id],
      { label: 'v16-atomic-decide' },
    );

    if (updated.length === 0) {
      // Already terminal — report final state honestly, strip keyboard
      const final = await pgQuery<{ status: string }>(
        `SELECT status FROM trinity_hitl_requests WHERE id::text = $1 LIMIT 1`,
        [row.request_id],
        { label: 'v16-final-status' },
      );
      const finalStatus = (final[0]?.status ?? 'unknown').toString();
      await answerCallback(callbackId, `Already ${finalStatus}`, true);
      await editMessageRemoveKeyboard(userChatId, messageId);
      res.sendStatus(200);
      return;
    }

    // 6. decision audit row — match the existing UPPERCASE convention on .decision
    let agentRepidText = 'unknown';
    try {
      const ag = await pgQuery<{ r: string }>(
        `SELECT current_repid::text AS r FROM repid_agents WHERE agent_name = $1 LIMIT 1`,
        [row.agent_id],
        { label: 'v16-agent-repid-lookup' },
      );
      if (ag[0]?.r) agentRepidText = String(ag[0].r);
    } catch { /* fall back to 'unknown' */ }

    const decisionSig = crypto
      .createHmac('sha256', getSecret())
      .update(`decision:${row.request_id}:${upperDecision}:${userChatId}`)
      .digest('hex');

    await db.from('trinity_hitl_decisions').insert({
      task_id: row.task_id,
      agent_id: row.agent_id,
      agent_repid: agentRepidText,
      mission_summary: String(row.reason ?? '').slice(0, 200),
      escalation_reason: String(row.reason ?? '').slice(0, 500),
      signature: decisionSig,
      telegram_message_id: messageId,
      decision: upperDecision,
      decided_at: new Date().toISOString(),
    });

    // 7. ack to Sean + strip the keyboard so re-clicks are clearly disabled
    await answerCallback(
      callbackId,
      decision === 'a' ? '✅ Approved' : '❌ Denied',
      false,
    );
    await editMessageRemoveKeyboard(userChatId, messageId);
    res.sendStatus(200);
  } catch (e: any) {
    console.error('[HitlCallbackHandler] unexpected error:', e?.message ?? e);
    try { await answerCallback(callbackId, 'Internal error — see logs', true); } catch {}
    // ALWAYS 200 to Telegram to suppress its retry storm
    res.sendStatus(200);
  }
}
