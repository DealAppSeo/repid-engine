import { db } from '../db';
import { deliverSignedWebhook } from './webhook-delivery';

/**
 * Deliver `event` to every active repid_webhooks row subscribed to it.
 *
 * [S2-4, 2026-10-16] Rows are registered by an operator only (POST /api/v1/webhooks/register). Each
 * delivery is HMAC-signed with that row's secret, which is kept in the existing `api_key` column
 * (no DDL) and never sent. It goes only to a public https address, and is refused when the secret is
 * empty. This used to POST to any stored URL with the stored value in an `x-api-key` header, and it
 * ran CREATE TABLE through run_sql on first use. Fire-and-forget: never throws.
 */
export async function fireWebhook(event: string, payload: any) {
  try {
    const { data: webhooks } = await db.from('repid_webhooks').select('url, api_key')
      .eq('active', true)
      .contains('events', [event]);
    const body = JSON.stringify({ event, payload });
    for (const wh of webhooks ?? []) void deliverSignedWebhook(wh.url, wh.api_key, body);
  } catch (e) {}
}
