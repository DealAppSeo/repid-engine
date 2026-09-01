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

/**
 * The event names a webhook can subscribe to.
 *
 * `score_event` is the only one that existed before 2026-08-31; `anchor_confirmed` is added
 * with the anchor ladder, so a receiver can be told the moment a proof's on-chain attestation
 * lands rather than polling the passport for it.
 */
export const NOTIFY_EVENTS = ['score_event', 'anchor_confirmed', 'timeout_expiration'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

interface WebhookConfig {
  url: string;
  secret: string;
  /** null when the column is unset — NOT the same as an empty subscription. See isSubscribed. */
  events: string[] | null;
}

/**
 * Does this webhook want this event?
 *
 * EXPLICIT OPT-IN, and the direction is deliberate. An unset or empty `webhook_events` means
 * NOTHING is delivered, not everything. Two reasons, and the second is the one that matters:
 *
 *   1. It matches the only live consumer this codebase already had —
 *      `(agent.webhook_events || []).includes('score_event')` in the score-event route. A second
 *      rule disagreeing with the first at the null boundary is how the tier ladder drifted four
 *      times.
 *   2. It means ADDING an event type can never surprise an existing subscriber. Someone who
 *      configured a webhook before `anchor_confirmed` existed cannot start receiving it by
 *      accident — they have to ask. The opposite default would silently widen every webhook in
 *      the system the moment this file gained a constant.
 */
export function isSubscribed(events: string[] | null | undefined, event: NotifyEvent): boolean {
  return Array.isArray(events) && events.includes(event);
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
      // This column was SELECTed and then thrown away — every caller was told the subscription
      // list had been consulted when nothing read it. Harmless so far only because this module
      // had no callers and no agent has a webhook configured; it is load-bearing the moment
      // either changes, which is now.
      events: (data.webhook_events as string[] | null) ?? null,
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

/* -------------------------------------------------------------------------- */
/* Agent-addressed delivery — "your on-chain receipt just landed"              */
/* -------------------------------------------------------------------------- */

/**
 * Three outcomes, never two.
 *
 * `not_subscribed` and `no_webhook` are NOT failures and must never be audited as drops. A
 * webhook that deliberately did not ask for this event, recorded as a failed delivery, is a
 * non-event reported as a fault — the mirror of the defect the anchor ladder just removed, where
 * a non-answer was reported as a verdict. Only `delivery_failed` means something went wrong.
 */
export type AgentNotifyOutcome =
  | { event: NotifyEvent; delivered: true; status: number }
  | { event: NotifyEvent; delivered: false; reason: 'no_webhook' | 'not_subscribed' }
  | { event: NotifyEvent; delivered: false; reason: 'delivery_failed'; status?: number; error?: string };

async function lookupAgentWebhook(agentId: string): Promise<WebhookConfig | null> {
  try {
    const { data } = await db
      .from('repid_agents')
      .select('webhook_url, webhook_secret, webhook_events')
      .eq('id', agentId)
      .maybeSingle();
    if (!data?.webhook_url) return null;
    return {
      url: String(data.webhook_url),
      secret: String(data.webhook_secret ?? ''),
      events: (data.webhook_events as string[] | null) ?? null,
    };
  } catch {
    // A lookup failure is not evidence that the agent has no webhook. It returns null so nothing
    // is delivered, and the caller reports `no_webhook` — which is why the caller must never
    // treat that as proof of an unsubscribed agent, only as "nothing was sent".
    return null;
  }
}

/**
 * Deliver one event to ONE agent's webhook.
 *
 * Addressed by agent rather than by builder because that is what the event is about: a specific
 * proof, for a specific agent, just acquired an on-chain attestation. `sendNotification` above
 * fans out per BUILDER and routes Telegram to a single owner chat — correct for operator alerts,
 * wrong for telling a user something happened to their own agent.
 *
 * This is deliberately webhook-only: no Telegram. Every anchored batch would otherwise page the
 * owner's chat once per agent, on a worker that runs every five minutes.
 */
export async function notifyAgentEvent(
  agentId: string,
  event: NotifyEvent,
  message: string,
  metadata: NotifyMetadata = {},
): Promise<AgentNotifyOutcome> {
  const cfg = await lookupAgentWebhook(agentId);
  if (!cfg) return { event, delivered: false, reason: 'no_webhook' };
  if (!isSubscribed(cfg.events, event)) return { event, delivered: false, reason: 'not_subscribed' };

  // `event` is inside the signed body, not just a header: a receiver that dispatches on the event
  // name must be able to trust it, and a value outside the preimage can be rewritten in transit.
  const body = JSON.stringify({
    event,
    agent_id: agentId,
    message,
    metadata,
    sent_at: new Date().toISOString(),
  });
  const signature = createHmac('sha256', cfg.secret).update(body).digest('hex');

  try {
    const r = await fetchWithTimeout(
      cfg.url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'X-Webhook-Signature': signature }, body },
      NOTIFY_TIMEOUT_MS,
    );
    if (r.ok) return { event, delivered: true, status: r.status };
    await auditDeliveryFailure(agentId, event, { status: r.status });
    return { event, delivered: false, reason: 'delivery_failed', status: r.status };
  } catch (e: any) {
    const error = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'unknown');
    await auditDeliveryFailure(agentId, event, { error });
    return { event, delivered: false, reason: 'delivery_failed', error };
  }
}

async function auditDeliveryFailure(
  agentId: string,
  event: NotifyEvent,
  detail: { status?: number; error?: string },
): Promise<void> {
  try {
    await emitAuditEvent({
      event_type: 'notification_failed',
      source_table: 'notifications',
      source_id: `notify-agent-${agentId}-${event}-${Date.now()}`,
      payload: { agent_id: agentId, event, ...detail },
    });
  } catch {
    // Auditing a drop must not itself become a throw inside a worker loop.
  }
}

// Helpers exposed for tests so they can drive the individual paths.
export const _internals = { deliverTelegram, deliverWebhook, lookupWebhookConfig, lookupAgentWebhook };
