import { db } from '../db';

export async function fireWebhook(event: string, payload: any) {
  try {
    const { data: webhooks } = await db.from('repid_webhooks').select('*')
      .eq('active', true)
      .contains('events', [event]);
    if (webhooks) {
      for (const wh of webhooks) {
        fetch(wh.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': wh.api_key || '' },
          body: JSON.stringify({ event, payload })
        }).catch(() => {});
      }
    }
  } catch (e) {}
}
