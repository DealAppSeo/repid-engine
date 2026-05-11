// Graph RAG end-to-end smoke test.
// Seeds SOPHIA with 5 memory nodes + 3 edges, then exercises retrieval
// with two queries. Run after the migration has been applied.
//
// Usage: npm run smoke:graph-rag
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { GraphRagStore } from '../src/services/graph-rag/graph-rag-store';
import { RetrievalService } from '../src/services/graph-rag/retrieval-service';

dotenv.config();

const SOPHIA = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SERVICE_KEY'
    );
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const store = new GraphRagStore(supabase);
  const retrieval = new RetrievalService(supabase);

  console.log('Seeding 5 memory nodes for SOPHIA...');

  const obs1 = await store.createNode({
    agent_id: SOPHIA,
    node_type: 'observation',
    content: 'User prefers swing trading over day trading',
    importance: 0.8,
  });
  const obs2 = await store.createNode({
    agent_id: SOPHIA,
    node_type: 'observation',
    content: 'User mentioned tax-loss harvesting in December',
    importance: 0.7,
  });
  const pref = await store.createNode({
    agent_id: SOPHIA,
    node_type: 'preference',
    content: 'User dislikes leveraged ETFs',
    importance: 0.9,
  });
  const goal = await store.createNode({
    agent_id: SOPHIA,
    node_type: 'goal',
    content: 'Build a stable dividend portfolio over 10 years',
    importance: 0.95,
  });
  const fact = await store.createNode({
    agent_id: SOPHIA,
    node_type: 'fact',
    content: 'User lives in California, subject to state capital gains',
    importance: 0.6,
  });

  console.log('Creating 3 edges...');
  await store.createEdge({
    from_node_id: pref.id,
    to_node_id: obs1.id,
    edge_type: 'reinforces',
    weight: 0.8,
  });
  await store.createEdge({
    from_node_id: goal.id,
    to_node_id: pref.id,
    edge_type: 'caused_by',
    weight: 0.7,
  });
  await store.createEdge({
    from_node_id: obs2.id,
    to_node_id: fact.id,
    edge_type: 'references',
    weight: 0.9,
  });

  console.log('\nRetrieving with query: "trading style"...');
  const results = await retrieval.retrieve({
    agent_id: SOPHIA,
    query: 'trading style',
    top_k: 3,
  });
  console.log(`Got ${results.length} results:`);
  for (const r of results) {
    console.log(
      `  similarity=${r.similarity.toFixed(3)} type=${r.node.node_type} content="${r.node.content}"`
    );
    for (const rel of r.related_nodes) {
      console.log(
        `    └─ ${rel.edge_type} (w=${rel.weight}): ${rel.node.content}`
      );
    }
  }

  console.log('\nRetrieving with query: "tax strategy"...');
  const results2 = await retrieval.retrieve({
    agent_id: SOPHIA,
    query: 'tax strategy',
    top_k: 3,
  });
  console.log(`Got ${results2.length} results:`);
  for (const r of results2) {
    console.log(
      `  similarity=${r.similarity.toFixed(3)} type=${r.node.node_type} content="${r.node.content}"`
    );
    for (const rel of r.related_nodes) {
      console.log(
        `    └─ ${rel.edge_type} (w=${rel.weight}): ${rel.node.content}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
