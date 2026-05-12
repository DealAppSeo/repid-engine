/**
 * Probe: ZKP proof generation pipeline.
 * Source of truth: repid_proof_queue table.
 */
import { getDb, classifyByActivity, ProbeResult } from './_shared';

export async function probeZkpPipeline(): Promise<ProbeResult> {
  const db = getDb();
  const now = new Date();
  const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const { count: count1h } = await db
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('completed_at', since1h);

  const { count: count24h } = await db
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('completed_at', since24h);

  const { data: latest } = await db
    .from('repid_proof_queue')
    .select('completed_at, agent_id')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const { data: unique } = await db
    .from('repid_proof_queue')
    .select('agent_id')
    .eq('status', 'completed')
    .gte('completed_at', since24h);
  const uniqueAgents = new Set((unique ?? []).map((r: any) => r.agent_id)).size;

  return {
    name: 'zkp-pipeline',
    status: classifyByActivity(count1h ?? 0, count24h ?? 0),
    metrics: {
      proofs_1h: count1h ?? 0,
      proofs_24h: count24h ?? 0,
      unique_agents_24h: uniqueAgents,
      last_proof_at: (latest as any)?.completed_at ?? null,
    },
  };
}

if (require.main === module) {
  probeZkpPipeline().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
