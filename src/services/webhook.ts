import { db } from '../db';

let initialized = false;

export async function fireWebhook(event: string, payload: any) {
  if (!initialized) {
    initialized = true;
    db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS repid_webhooks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT NOT NULL, events TEXT[], api_key TEXT, created_at TIMESTAMP DEFAULT NOW(), active BOOLEAN DEFAULT true);' }).catch(() => {});
  }
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
