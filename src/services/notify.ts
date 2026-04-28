/**
 * Real notification delivery — Telegram + webhook.
 *
 * sendNotification(builderId, message, metadata?) fan-outs across two
 * independent paths via Promise.allSettled:
 *
 *   1. Telegram — POST to api.telegram.org/bot${TOKEN}/sendMessage
 *      with chat_id = TELEGRAM_OWNER_CHAT_ID (Sean's chat). v0.1
 *      routes EVERY notification to Sean; per-builder routing is a
 *      v0.2 follow-up.
 *
 *   2. Webhook — looks up webhook_url + webhook_secret on repid_agents
 *      (via builder_id linkage). HMAC-SHA256 over the body keyed with
 *      webhook_secret, sent in X-Webhook-Signature.
 *
 * Both paths fail soft. Failures emit an event to hal_audit_chain
 * with event_type='notification_failed' so a downstream observer can
 * see drop rate without re-driving the deliveries.
 *
 * Returns { telegram, webhook } summary so callers can log the
 * outcome but never throws.
 */

import { createHmac } from 'crypto';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const TELEGRAM_API = 'https://api.telegram.org';
const NOTIFY_TIMEOUT_MS = 5000;

export interface NotifyResult {
  telegram: { ok: boolean; status?: number; error?: string };
  webhook: { ok: boolean; status?: number; error?: string; skipped?: boolean };
}

export interface NotifyMetadata {
  // Free-form. Surfaced to webhook receivers as the body's "metadata"
  // field; never sent inline in Telegram message bodies (would leak
  // implementation details to Sean's chat).
  [k: string]: unknown;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function deliverTelegram(message: string): Promise<NotifyResult['telegram']> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, error: 'env_unset' };
  }
  try {
    const r = await fetchWithTimeout(
      `${TELEGRAM_API}/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      },
      NOTIFY_TIMEOUT_MS,
    );
    return { ok: r.ok, status: r.status };
  } catch (e: any) {
    const isTimeout = e?.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : (e?.message ?? 'unknown') };
  }
}

interface WebhookConfig {
  url: string;
  secret: string;
}

async function lookupWebhookConfig(builderId: string): Promise<WebhookConfig | null> {
  // builders -> repid_agents.builder_id -> agent.webhook_url/secret. The
  // first agent under the builder with a webhook_url wins. v0.2 may add
  // a per-builder webhook column; v0.1 reuses the existing repid_agents
  // shape (same columns the v11 external-agent flow uses).
  try {
    const { data } = await db
      .from('repid_agents')
      .select('webhook_url, webhook_secret, webhook_events')
      .eq('builder_id', builderId)
      .not('webhook_url', 'is', null)
      .limit(1)
      .maybeSingle();
    if (!data?.webhook_url) return null;
    return {
      url: String(data.webhook_url),
      secret: String(data.webhook_secret ?? ''),
    };
  } catch {
    return null;
  }
}

async function deliverWebhook(builderId: string, message: string, metadata: NotifyMetadata): Promise<NotifyResult['webhook']> {
  const cfg = await lookupWebhookConfig(builderId);
  if (!cfg) return { ok: false, skipped: true, error: 'no_webhook_configured' };

  const body = JSON.stringify({
    builder_id: builderId,
    message,
    metadata,
    sent_at: new Date().toISOString(),
  });
  const signature = createHmac('sha256', cfg.secret).update(body).digest('hex');
  try {
    const r = await fetchWithTimeout(
      cfg.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body,
      },
      NOTIFY_TIMEOUT_MS,
    );
    return { ok: r.ok, status: r.status };
  } catch (e: any) {
    const isTimeout = e?.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : (e?.message ?? 'unknown') };
  }
}

export async function sendNotification(
  builderId: string,
  message: string,
  metadata: NotifyMetadata = {},
): Promise<NotifyResult> {
  const [tgRes, wbRes] = await Promise.allSettled([
    deliverTelegram(message),
    deliverWebhook(builderId, message, metadata),
  ]);

  const telegram: NotifyResult['telegram'] = tgRes.status === 'fulfilled'
    ? tgRes.value
    : { ok: false, error: String((tgRes as PromiseRejectedResult).reason ?? 'rejected') };

  const webhook: NotifyResult['webhook'] = wbRes.status === 'fulfilled'
    ? wbRes.value
    : { ok: false, error: String((wbRes as PromiseRejectedResult).reason ?? 'rejected') };

  // Audit on any failure (excluding the "no webhook configured" skip,
  // which isn't a failure — it's a deliberately-unconfigured builder).
  const tgFailed = !telegram.ok;
  const wbFailed = !webhook.ok && !webhook.skipped;
  if (tgFailed || wbFailed) {
    await emitAuditEvent({
      event_type: 'notification_failed',
      source_table: 'notifications',
      source_id: `notify-${builderId}-${Date.now()}`,
      payload: {
        builder_id: builderId,
        telegram_ok: telegram.ok,
        telegram_error: telegram.error,
        webhook_ok: webhook.ok,
        webhook_skipped: webhook.skipped,
        webhook_error: webhook.error,
      },
    });
  }

  return { telegram, webhook };
}

// Helpers exposed for tests so they can drive the individual paths.
export const _internals = { deliverTelegram, deliverWebhook, lookupWebhookConfig };
