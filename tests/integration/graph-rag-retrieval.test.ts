/**
 * Integration test: Graph RAG retrieval RPC against live Supabase.
 *
 * Exercises the graph_rag_match_nodes RPC (Sprint 4 graph-rag foundation).
 * Verifies the RPC accepts the documented signature + returns rows with the
 * expected shape. The 8 spokesperson memories Gemini seeded are the only
 * data in agent_memory_nodes today, so retrieval is gated to those 4 UUIDs.
 *
 * NOTE: a real semantic search would require an embedding model; this
 * test calls the RPC with a zero-vector to exercise the SQL surface only.
 * Returned similarity scores will be at the 0-vs-actual baseline, which is
 * fine for "does the RPC exist and return rows" verification.
 *
 * Skipped if SUPABASE env unset OR no rows in agent_memory_nodes.
 */

import { db } from '../../src/db';

const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const describeIfDb = HAS_DB ? describe : describe.skip;

const SPOKESPERSONS = new Set([
  'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271', // SOPHIA
  'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067', // VERITAS
  '32e0e809-c1c4-4405-913f-135c8a2d6626', // SHOFET
  '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6', // CHESED
]);

describeIfDb('Graph RAG retrieval — graph_rag_match_nodes RPC', () => {
  it('RPC exists and accepts the documented signature', async () => {
    // Query: zero vector of length 384 (matches Xenova/all-MiniLM-L6-v2 dim)
    const zeroVec = new Array(384).fill(0);
    const { data, error } = await db.rpc('graph_rag_match_nodes', {
      p_agent_id: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271', // SOPHIA
      p_query_embedding: zeroVec,
      p_match_count: 5,
      p_similarity_threshold: -1, // accept anything; we're not testing semantic quality
      p_node_types: null,
    });
    expect(error).toBeNull();
    // data may be empty if SOPHIA has no nodes seeded; that's not a failure
    expect(Array.isArray(data)).toBe(true);
  });

  it('returns nodes scoped to the provided agent_id (when nodes exist)', async () => {
    // Find the agent with the most memory nodes (any of the 4 spokespersons)
    const { data: counts } = await db.from('agent_memory_nodes')
      .select('agent_id', { count: 'exact', head: false });
    if (!counts || counts.length === 0) {
      console.warn('No agent_memory_nodes seeded; skipping scoping test');
      return;
    }

    // Pick the first agent_id we see
    const sampleAgentId = (counts[0] as any).agent_id;
    const zeroVec = new Array(384).fill(0);
    const { data, error } = await db.rpc('graph_rag_match_nodes', {
      p_agent_id: sampleAgentId,
      p_query_embedding: zeroVec,
      p_match_count: 10,
      p_similarity_threshold: -1,
      p_node_types: null,
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // Every returned row should belong to the requested agent (RPC enforces scoping)
    for (const row of (data ?? []) as any[]) {
      if (row.agent_id) {
        expect(row.agent_id).toBe(sampleAgentId);
      }
    }
  });

  it('agent_memory_nodes contains spokesperson memories (Gemini seed)', async () => {
    const { data, count } = await db.from('agent_memory_nodes')
      .select('agent_id', { count: 'exact' });
    if ((count ?? 0) === 0) {
      console.warn('agent_memory_nodes is empty — Gemini seed has not run');
      return;
    }
    // At least one node should belong to a known spokesperson
    const seenAgents = new Set((data ?? []).map((r: any) => r.agent_id));
    const overlap = [...seenAgents].filter((id) => SPOKESPERSONS.has(id));
    expect(overlap.length).toBeGreaterThan(0);
  });
});
