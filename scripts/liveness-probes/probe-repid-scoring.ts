/**
 * Probe: RepID scoring activity (canonical repid_score_events + legacy repid_events).
 * Distinguishes agent-triggered vs demo-triggered by metadata.source.
 */
import { getDb, classifyByActivity, ProbeResult } from './_shared';

export async function probeRepidScoring(): Promise<ProbeResult> {
  const db = getDb();
  const now = new Date();
  const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Canonical: repid_score_events
  const { count: rseCount1h } = await db
    .from('repid_score_events').select('*', { count: 'exact', head: true })
    .gte('created_at', since1h);
  const { count: rseCount24h } = await db
    .from('repid_score_events').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);
  const { data: latestRse } = await db
    .from('repid_score_events').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  // Pull recent rows to split agent-triggered vs demo (per metadata.source if present)
  const { data: recentRows } = await db
    .from('repid_score_events').select('metadata')
    .gte('created_at', since24h);
  let agentTriggered = 0;
  let demoTriggered = 0;
  for (const r of (recentRows ?? []) as any[]) {
    const src = r?.metadata?.source ?? '';
    if (src === 'paper_trading' || src === 'agent') agentTriggered++;
    else if (src.includes('demo') || src.includes('manual') || src.includes('admin')) demoTriggered++;
    // Rows without a source are uncounted (legacy / unknown origin)
  }

  // Legacy: repid_events
  const { count: reCount24h } = await db
    .from('repid_events').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);

  return {
    name: 'repid-scoring',
    status: classifyByActivity(rseCount1h ?? 0, rseCount24h ?? 0),
    metrics: {
      canonical_status: classifyByActivity(rseCount1h ?? 0, rseCount24h ?? 0),
      score_events_1h: rseCount1h ?? 0,
      score_events_24h: rseCount24h ?? 0,
      last_score_event_at: (latestRse as any)?.created_at ?? null,
      agent_triggered_24h: agentTriggered,
      demo_triggered_24h: demoTriggered,
      legacy_status: (reCount24h ?? 0) >= 1 ? 'AMBER' : 'RED',
      legacy_events_24h: reCount24h ?? 0,
    },
  };
}

if (require.main === module) {
  probeRepidScoring().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
