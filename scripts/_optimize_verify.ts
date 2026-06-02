import { db } from '../src/db';
import { summarize } from '../src/routes/costs';
(async () => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await db.from('llm_call_log')
    .select('provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, agent_id, task_hint, status')
    .gte('created_at', since).limit(20000);
  if (error) { console.error(error.message); process.exit(1); }
  const s = summarize((data ?? []) as any);
  console.log('LIVE /costs/summary:');
  console.log(JSON.stringify(s.last_24h, null, 2));
  console.log('by_provider:', JSON.stringify(s.by_provider, null, 0).slice(0, 400));
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
