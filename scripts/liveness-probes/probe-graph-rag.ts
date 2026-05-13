/**
 * Probe: Graph RAG memory (agent_memory_nodes + agent_memory_edges).
 * PASS: nodes growing AND edges growing.
 * AMBER: nodes growing, edges flat.
 * RED: both flat for 24h.
 */
import { getDb, ProbeResult, ProbeStatus } from './_shared';

export async function probeGraphRag(): Promise<ProbeResult> {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: nodeCount } = await db
    .from('agent_memory_nodes').select('*', { count: 'exact', head: true });
  const { count: edgeCount } = await db
    .from('agent_memory_edges').select('*', { count: 'exact', head: true });

  const { count: newNodes24h } = await db
    .from('agent_memory_nodes').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);
  const { count: newEdges24h } = await db
    .from('agent_memory_edges').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);

  const { data: latestNode } = await db
    .from('agent_memory_nodes').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: latestEdge } = await db
    .from('agent_memory_edges').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  let status: ProbeStatus;
  if ((newNodes24h ?? 0) >= 1 && (newEdges24h ?? 0) >= 1) status = 'GREEN';
  else if ((newNodes24h ?? 0) >= 1) status = 'AMBER';
  else status = 'RED';

  return {
    name: 'graph-rag',
    status,
    metrics: {
      node_count: nodeCount ?? 0,
      edge_count: edgeCount ?? 0,
      new_nodes_24h: newNodes24h ?? 0,
      new_edges_24h: newEdges24h ?? 0,
      last_node_at: (latestNode as any)?.created_at ?? null,
      last_edge_at: (latestEdge as any)?.created_at ?? null,
    },
    message: (edgeCount ?? 0) === 0
      ? 'agent_memory_edges has never been written — write-side hook never exercised end-to-end'
      : undefined,
  };
}

if (require.main === module) {
  probeGraphRag().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
