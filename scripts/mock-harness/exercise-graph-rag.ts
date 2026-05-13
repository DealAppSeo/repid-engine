/**
 * CC Sprint 9 Phase 4 — Exercise Graph RAG retrieval + first edge creation.
 *
 * Per dispatcher: uses SOPHIA's UUID READ-ONLY for retrieval; creates ONE
 * synthetic edge between two of SOPHIA's existing memory_nodes to prove the
 * write path (agent_memory_edges currently has 0 rows). Cleans up the edge
 * on exit.
 *
 * This is the first write to agent_memory_edges in the system's history.
 */

import 'dotenv/config';
import { getDb } from '../liveness-probes/_shared';

const SOPHIA_UUID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

(async () => {
  const db = getDb();

  console.log('[exercise-graph-rag] testing graph_rag_match_nodes RPC...');
  const zeroVec = new Array(384).fill(0);
  const { data: matches, error: rpcErr } = await db.rpc('graph_rag_match_nodes', {
    p_agent_id: SOPHIA_UUID,
    p_query_embedding: zeroVec,
    p_match_count: 5,
    p_similarity_threshold: -1,
    p_node_types: null,
  });
  if (rpcErr) { console.error(`  RPC failed: ${rpcErr.message}`); process.exit(1); }
  console.log(`  RPC returned ${matches?.length ?? 0} rows`);

  // Find two of SOPHIA's existing nodes to link
  console.log('[exercise-graph-rag] reading SOPHIA memory nodes for edge candidates...');
  const { data: nodes } = await db.from('agent_memory_nodes')
    .select('id').eq('agent_id', SOPHIA_UUID).limit(2);
  if (!nodes || nodes.length < 2) {
    console.log(`  SOPHIA has only ${nodes?.length ?? 0} nodes — need ≥ 2 to create a synthetic edge`);
    console.log('[exercise-graph-rag] LIMITATION: skipping edge write (insufficient nodes)');
    console.log('[exercise-graph-rag] DONE (read-only)');
    return;
  }
  const [n1, n2] = nodes as any[];
  console.log(`  using nodes: ${n1.id} → ${n2.id}`);

  console.log('[exercise-graph-rag] inserting synthetic edge...');
  const { data: edge, error: edgeErr } = await db.from('agent_memory_edges').insert({
    from_node_id: n1.id,
    to_node_id: n2.id,
    // edge_type is constrained to: mentions, response_to, caused_by, contradicts, reinforces, references
    // (RULE-8 finding: dispatcher assumed free-form edge_type — actual schema is an enum CHECK)
    edge_type: 'references',
    weight: 0.5,
    metadata: { staged_by: 'cc-sprint-9-exercise-graph-rag', synthetic: true },
  }).select('id').single();
  if (edgeErr) {
    console.error(`  edge insert failed: ${edgeErr.message}`);
    console.log('[exercise-graph-rag] LIMITATION: agent_memory_edges schema differs from assumed shape');
    console.log('  Surfacing as Sean action item: verify agent_memory_edges columns');
    process.exit(1);
  }
  console.log(`  edge created id=${(edge as any).id}`);

  // Verify count
  const { count } = await db.from('agent_memory_edges').select('*', { count: 'exact', head: true });
  console.log(`  agent_memory_edges total count is now: ${count}`);

  console.log('[exercise-graph-rag] cleanup...');
  await db.from('agent_memory_edges').delete().eq('id', (edge as any).id);
  const { count: afterCleanup } = await db.from('agent_memory_edges').select('*', { count: 'exact', head: true });
  console.log(`  agent_memory_edges count after cleanup: ${afterCleanup}`);

  console.log('[exercise-graph-rag] DONE');
})().catch((e) => { console.error('exercise-graph-rag crashed:', e); process.exit(1); });
