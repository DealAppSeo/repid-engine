import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from './embedding-service';
import { GraphRagStore } from './graph-rag-store';
import type {
  RetrievalResult,
  RetrievalOptions,
  ScopedRetrievalOptions,
  MemoryNode,
  EdgeType,
} from '../../types/graph-rag';

function toPgVector(arr: number[]): string {
  return '[' + arr.join(',') + ']';
}

interface MatchRow extends Omit<MemoryNode, 'embedding'> {
  similarity: number;
}

interface EdgeRow {
  to_node_id: string;
  edge_type: EdgeType;
  weight: number;
}

export class RetrievalService {
  private store: GraphRagStore;

  constructor(private supabase: SupabaseClient) {
    this.store = new GraphRagStore(supabase);
  }

  async retrieve(opts: RetrievalOptions): Promise<RetrievalResult[]> {
    const queryEmbedding = await embed(opts.query);

    const { data, error } = await this.supabase.rpc('graph_rag_match_nodes', {
      p_agent_id: opts.agent_id,
      p_query_embedding: toPgVector(queryEmbedding),
      p_match_count: opts.top_k ?? 5,
      p_similarity_threshold: opts.similarity_threshold ?? 0.65,
      p_node_types: opts.node_types ?? null,
    });

    if (error) throw new Error(`retrieve failed: ${error.message}`);
    return this.hydrate(data as MatchRow[] | null, opts.include_related ?? true);
  }

  /**
   * Agent-independent retrieval, for shared lessons. Backed by
   * graph_rag_match_scoped; graph_rag_match_nodes is deliberately untouched
   * because it has live callers and a signature change would break them.
   */
  async retrieveScoped(
    opts: ScopedRetrievalOptions
  ): Promise<RetrievalResult[]> {
    const queryEmbedding = await embed(opts.query);

    const { data, error } = await this.supabase.rpc('graph_rag_match_scoped', {
      p_scope: opts.scope,
      p_query_embedding: toPgVector(queryEmbedding),
      p_match_count: opts.top_k ?? 5,
      p_similarity_threshold: opts.similarity_threshold ?? 0.65,
      p_node_types: opts.node_types ?? null,
    });

    if (error) throw new Error(`retrieveScoped failed: ${error.message}`);
    return this.hydrate(data as MatchRow[] | null, opts.include_related ?? true);
  }

  /** Shared tail of both retrieval paths: one-hop edge walk, read-stat touch,
   *  and row→RetrievalResult mapping. */
  private async hydrate(
    data: MatchRow[] | null,
    includeRelated: boolean
  ): Promise<RetrievalResult[]> {
    if (!data || data.length === 0) return [];

    const matches = data;
    const results: RetrievalResult[] = [];

    for (const row of matches) {
      const related: RetrievalResult['related_nodes'] = [];

      if (includeRelated) {
        const { data: edges } = await this.supabase
          .from('agent_memory_edges')
          .select('to_node_id, edge_type, weight')
          .eq('from_node_id', row.id);

        const edgeRows = (edges ?? []) as EdgeRow[];
        if (edgeRows.length > 0) {
          const toIds = edgeRows.map((e) => e.to_node_id);
          const { data: relatedNodes } = await this.supabase
            .from('agent_memory_nodes')
            .select(
              'id, agent_id, node_type, content, metadata, source_event_id, importance, created_at, accessed_at, access_count'
            )
            .in('id', toIds);

          if (relatedNodes) {
            const byId = new Map(
              (relatedNodes as MemoryNode[]).map((n) => [n.id, n])
            );
            for (const e of edgeRows) {
              const node = byId.get(e.to_node_id);
              if (node) {
                related.push({
                  node,
                  edge_type: e.edge_type,
                  weight: Number(e.weight),
                });
              }
            }
          }
        }
      }

      // Update read-stats async; failures don't affect the response.
      void this.store.touchNode(row.id).catch(() => {
        /* swallow */
      });

      results.push({
        node: {
          id: row.id,
          agent_id: row.agent_id,
          scope: row.scope ?? null,
          node_type: row.node_type,
          content: row.content,
          metadata: row.metadata,
          source_event_id: row.source_event_id,
          importance: Number(row.importance),
          created_at: row.created_at,
          accessed_at: row.accessed_at,
          access_count: row.access_count,
        },
        similarity: Number(row.similarity),
        related_nodes: related,
      });
    }

    return results;
  }
}
