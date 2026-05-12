/**
 * CC Sprint 10 Phase 3.4 — Graph RAG edge inference CLI.
 *
 * Usage:
 *   npm run graph-rag:infer-edges -- --dry-run               # default: just print
 *   npm run graph-rag:infer-edges -- --agent <uuid>          # restrict to one agent
 *   npm run graph-rag:infer-edges -- --apply                 # persist (gated)
 *
 * Dry-run produces:
 *   - total node count examined
 *   - inferred edges grouped by edge_type
 *   - per-agent breakdown
 *   - rejected_by_check + deduplicated counts
 *
 * Phase 4 wires this script to graph_rag_edge_inference_metrics so every run
 * (dry-run or apply) leaves an audit trail.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { config } from '../../src/config';
import { inferEdges, persistEdges, type InferredEdge } from '../../src/services/graph-rag-edge-inference';

interface CliArgs { dryRun: boolean; apply: boolean; agentId?: string; }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: true, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply') { out.apply = true; out.dryRun = false; }
    else if (a === '--agent') { out.agentId = argv[++i]; }
  }
  return out;
}

function groupByType(edges: InferredEdge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[e.edge_type] = (out[e.edge_type] ?? 0) + 1;
  return out;
}

function groupByAgent(edges: InferredEdge[], lookup: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) {
    const agent = lookup.get(e.from_node_id) ?? 'unknown';
    out[agent] = (out[agent] ?? 0) + 1;
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[infer-edges] mode=${args.apply ? 'APPLY' : 'DRY-RUN'}${args.agentId ? ` agent=${args.agentId}` : ''}`);

  const db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
  const inferenceStartedAt = new Date().toISOString();

  // Count nodes examined (for the metrics row)
  let nodesExamined = 0;
  {
    let countQuery = db.from('agent_memory_nodes').select('*', { count: 'exact', head: true });
    if (args.agentId) countQuery = countQuery.eq('agent_id', args.agentId);
    const { count } = await countQuery;
    nodesExamined = count ?? 0;
  }

  const edges = await inferEdges({ agentId: args.agentId });
  console.log(`[infer-edges] inferred ${edges.length} edges`);

  const byType = groupByType(edges);
  console.log('[infer-edges] by edge_type:');
  for (const [k, v] of Object.entries(byType)) console.log(`    ${k.padEnd(14)} ${v}`);

  // Lightweight per-agent attribution lookup
  const nodeToAgent = new Map<string, string>();
  const { data: nodes } = await db.from('agent_memory_nodes').select('id, agent_id');
  for (const r of (nodes ?? []) as any[]) nodeToAgent.set(r.id, r.agent_id);

  const byAgent = groupByAgent(edges, nodeToAgent);
  console.log('[infer-edges] by from-agent:');
  for (const [k, v] of Object.entries(byAgent)) console.log(`    ${k}  ${v}`);

  const result = await persistEdges(edges, { dryRun: args.dryRun });
  console.log('[infer-edges] result:');
  console.log(`    inferred:           ${result.inferred}`);
  console.log(`    persisted:          ${result.persisted}${args.dryRun ? '  (dry-run; no DB writes)' : ''}`);
  console.log(`    deduplicated:       ${result.deduplicated}`);
  console.log(`    rejected_by_check:  ${result.rejected_by_check}`);

  // Phase 4 — log this run to graph_rag_edge_inference_metrics for audit trail
  const { data: metricRow, error: metricErr } = await db.from('graph_rag_edge_inference_metrics').insert({
    agent_id: args.agentId ?? null,
    inference_started_at: inferenceStartedAt,
    inference_completed_at: new Date().toISOString(),
    nodes_examined: nodesExamined,
    edges_inferred: result.inferred,
    edges_persisted: result.persisted,
    edges_deduplicated: result.deduplicated,
    edges_rejected_check: result.rejected_by_check,
    edge_type_distribution: byType,
    dry_run: args.dryRun,
    notes: `cc-sprint-10-cli; agents-by-source: ${JSON.stringify(byAgent)}`,
  }).select('id, run_id').single();
  if (metricErr) {
    console.warn(`[infer-edges] metrics write failed (continuing): ${metricErr.message}`);
  } else if (metricRow) {
    console.log(`[infer-edges] metrics row id=${(metricRow as any).id} run_id=${(metricRow as any).run_id}`);
  }

  console.log(`[infer-edges] DONE`);
})().catch((e) => { console.error('infer-edges crashed:', e); process.exit(1); });
