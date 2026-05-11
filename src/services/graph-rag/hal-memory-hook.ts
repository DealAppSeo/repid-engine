// HAL pipeline → Graph RAG memory hook.
//
// Called from /api/v1/agents/:id/score-event after the decision is
// finalized and the score event is persisted. Writes 1-3 memory nodes:
//   - observation: the incoming prompt (if supplied)
//   - decision:    the decision text + HAL outcome metadata
//   - reflection:  ONLY for constitutional-block / veto cases
//
// Fire-and-forget: this function never throws. Internal errors are
// logged but swallowed. Memory failures must NEVER block the HAL
// pipeline response.
//
// Schema dependency: agent_memory_nodes + agent_memory_edges
// (migrations/2026-05-10-graph-rag-foundation.sql).
// Until that migration is applied, every call here will fail-silently.
import type { SupabaseClient } from '@supabase/supabase-js';
import { GraphRagStore } from './graph-rag-store';
import type { NodeType } from '../../types/graph-rag';

export interface DecisionContext {
  agentId: string;
  prompt: string;
  decisionText: string;
  halScore: number;
  repidDelta: number;
  newRepid: number;
  commaVeto: boolean;
  sourceEventId?: number;
}

/**
 * Write memory nodes for a single decision. Fire-and-forget — never throws.
 *
 * Importance heuristic:
 *   - Vetoed: 0.85 (high — these become training cases)
 *   - Otherwise: 0.65 + |delta|/1000 capped at 0.95
 *
 * Edge: decision -[response_to]-> observation (when prompt is present).
 * Optional: reflection -[references]-> decision (when commaVeto).
 */
export async function writeDecisionMemory(
  supabase: SupabaseClient,
  ctx: DecisionContext
): Promise<void> {
  const store = new GraphRagStore(supabase);

  const importance = ctx.commaVeto
    ? 0.85
    : Math.min(0.95, 0.65 + Math.abs(ctx.repidDelta) / 1000);

  try {
    let obsNodeId: string | null = null;

    // Node 1: prompt as OBSERVATION (only when present)
    if (ctx.prompt && ctx.prompt.trim().length > 0) {
      const obsNode = await store.createNode({
        agent_id: ctx.agentId,
        node_type: 'observation' as NodeType,
        content: ctx.prompt.slice(0, 4000), // guard against huge payloads
        importance: 0.5,
        source_event_id: ctx.sourceEventId,
        metadata: { source: 'hal_pipeline', kind: 'incoming_prompt' },
      });
      obsNodeId = obsNode.id;
    }

    // Node 2: decision as DECISION node
    if (!ctx.decisionText || ctx.decisionText.trim().length === 0) {
      // No decision text — nothing meaningful to remember. Bail out.
      return;
    }
    const decNode = await store.createNode({
      agent_id: ctx.agentId,
      node_type: 'decision' as NodeType,
      content: ctx.decisionText.slice(0, 4000),
      importance,
      source_event_id: ctx.sourceEventId,
      metadata: {
        source: 'hal_pipeline',
        hal_score: ctx.halScore,
        repid_delta: ctx.repidDelta,
        new_repid: ctx.newRepid,
        comma_veto: ctx.commaVeto,
      },
    });

    // Edge: decision -[response_to]-> observation
    if (obsNodeId) {
      try {
        await store.createEdge({
          from_node_id: decNode.id,
          to_node_id: obsNodeId,
          edge_type: 'response_to',
          weight: 1.0,
          metadata: { auto: true },
        });
      } catch (edgeErr) {
        // Unique-edge constraint or DB hiccup — fine, decision still recorded.
        console.warn(
          '[hal-memory-hook] response_to edge failed (non-fatal):',
          edgeErr instanceof Error ? edgeErr.message : edgeErr
        );
      }
    }

    // Optional Node 3: reflection for vetoed decisions
    if (ctx.commaVeto) {
      const refContent = `Constitutional veto triggered. Prompt excerpt: "${ctx.prompt.slice(0, 200)}". Decision excerpt: "${ctx.decisionText.slice(0, 200)}".`;
      const refNode = await store.createNode({
        agent_id: ctx.agentId,
        node_type: 'reflection' as NodeType,
        content: refContent,
        importance: 0.9,
        source_event_id: ctx.sourceEventId,
        metadata: { source: 'hal_pipeline', kind: 'veto_reflection' },
      });

      try {
        await store.createEdge({
          from_node_id: refNode.id,
          to_node_id: decNode.id,
          edge_type: 'references',
          weight: 1.0,
          metadata: { auto: true },
        });
      } catch (edgeErr) {
        console.warn(
          '[hal-memory-hook] reflection->decision edge failed (non-fatal):',
          edgeErr instanceof Error ? edgeErr.message : edgeErr
        );
      }
    }
  } catch (err) {
    // Log but never throw. Memory failures must not break HAL.
    console.error(
      '[hal-memory-hook] write failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}
