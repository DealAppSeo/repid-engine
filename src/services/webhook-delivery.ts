/**
 * [S2-4, 2026-10-16] The one way the engine POSTs an event to a URL that someone else registered.
 *
 * There were three paths: services/webhook.ts (repid_webhooks), the score_event block in
 * routes/agents-external.ts, and services/notify.ts. Each fetched the stored URL as given. Any scheme
 * or host was accepted, redirects were followed blindly, and the signature was an HMAC keyed with
 * `secret || ''` (or none at all: webhook.ts sent its stored key in an x-api-key header). Now every
 * delivery:
 *   - refuses an empty secret, because an HMAC under '' is a signature anyone can compute;
 *   - goes only to a public https address (resolvedTargetProblem, the same guard the ERC-8004
 *     feedback verifier uses), checked again at every redirect hop;
 *   - carries X-Webhook-Signature = hex HMAC-SHA256(secret, body) and never the secret itself;
 *   - never throws.
 */
import { createHmac } from 'crypto';
import { MAX_REDIRECTS, resolvedTargetProblem } from './erc8004-feedback-verify';

export const WEBHOOK_TIMEOUT_MS = 5000;

export type WebhookDelivery = { ok: true; status: number } | { ok: false; status?: number; error: string };

export async function deliverSignedWebhook(
  url: string,
  secret: string | null | undefined,
  body: string,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): Promise<WebhookDelivery> {
  if (!secret) return { ok: false, error: 'no_webhook_secret' };
  const headers = { 'content-type': 'application/json', 'X-Webhook-Signature': createHmac('sha256', secret).update(body).digest('hex') };
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const problem = await resolvedTargetProblem(target);
      if (problem) return { ok: false, error: `not delivered: ${problem}` };
      const res = await fetch(target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, status: res.status, error: `http ${res.status} without a location` };
        target = new URL(location, target).toString();
        continue;
      }
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `http ${res.status}` };
    }
    return { ok: false, error: `not delivered: more than ${MAX_REDIRECTS} redirects` };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, error: timedOut ? 'timeout' : (e?.message ?? 'unknown') };
  }
}
