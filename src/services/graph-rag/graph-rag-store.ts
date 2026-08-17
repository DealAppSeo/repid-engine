import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from './embedding-service';
import type {
  MemoryNode,
  MemoryEdge,
  NodeType,
  EdgeType,
} from '../../types/graph-rag';

export interface CreateNodeArgs {
  /** Omit for a scoped (agent-independent) node; supply `scope` instead. The DB
   *  requires at least one of the two — a node with neither is unreachable. */
  agent_id?: string | null;
  scope?: string | null;
  node_type: NodeType;
  content: string;
  metadata?: Record<string, unknown>;
  source_event_id?: number;
  importance?: number;
}

export interface CreateEdgeArgs {
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

// pgvector accepts the bracketed-literal form via PostgREST without an
// explicit cast. Safer than relying on supabase-js to coerce a number[]
// into a vector — this works on every supabase-js / pgvector combo.
function toPgVector(arr: number[]): string {
  return '[' + arr.join(',') + ']';
}

export class GraphRagStore {
  constructor(private supabase: SupabaseClient) {}

  async createNode(args: CreateNodeArgs): Promise<MemoryNode> {
    const agentId = args.agent_id ?? null;
    const scope = args.scope ?? null;
    if (!agentId && !scope) {
      // Caught here rather than as a 23514 from the DB check, because the
      // constraint violation does not say which of the two you forgot.
      throw new Error(
        'createNode failed: node needs an agent_id or a scope — one with neither is unreachable by every read path',
      );
    }
    const embedding = await embed(args.content);
    const { data, error } = await this.supabase
      .from('agent_memory_nodes')
      .insert({
        agent_id: agentId,
        scope,
        node_type: args.node_type,
        content: args.content,
        embedding: toPgVector(embedding),
        metadata: args.metadata ?? {},
        source_event_id: args.source_event_id ?? null,
        importance: args.importance ?? 0.5,
      })
      .select('id, agent_id, scope, node_type, content, metadata, source_event_id, importance, created_at, accessed_at, access_count')
      .single();
    if (error) throw new Error(`createNode failed: ${error.message}`);
    return data as MemoryNode;
  }

  async createEdge(args: CreateEdgeArgs): Promise<MemoryEdge> {
    const { data, error } = await this.supabase
      .from('agent_memory_edges')
      .insert({
        from_node_id: args.from_node_id,
        to_node_id: args.to_node_id,
        edge_type: args.edge_type,
        weight: args.weight ?? 0.5,
        metadata: args.metadata ?? {},
      })
      .select('*')
      .single();
    if (error) throw new Error(`createEdge failed: ${error.message}`);
    return data as MemoryEdge;
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    const { data, error } = await this.supabase
      .from('agent_memory_nodes')
      .select('id, agent_id, node_type, content, metadata, source_event_id, importance, created_at, accessed_at, access_count')
      .eq('id', nodeId)
      .maybeSingle();
    if (error) throw new Error(`getNode failed: ${error.message}`);
    return (data as MemoryNode) ?? null;
  }

  async touchNode(nodeId: string): Promise<void> {
    const { error } = await this.supabase.rpc('graph_rag_touch_node', {
      p_node_id: nodeId,
    });
    if (error) {
      // Fallback if RPC missing: best-effort accessed_at update.
      await this.supabase
        .from('agent_memory_nodes')
        .update({ accessed_at: new Date().toISOString() })
        .eq('id', nodeId);
    }
  }
}
