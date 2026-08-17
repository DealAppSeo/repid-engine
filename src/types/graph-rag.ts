export type NodeType =
  | 'observation'
  | 'decision'
  | 'fact'
  | 'preference'
  | 'goal'
  | 'interaction'
  | 'reflection';

export type EdgeType =
  | 'mentions'
  | 'response_to'
  | 'caused_by'
  | 'contradicts'
  | 'reinforces'
  | 'references';

/** Agent-independent node scopes. Shared lessons live here rather than under a
 *  synthetic agent — agent_id FKs to repid_agents, the canonical scoring and
 *  ERC-8004 identity table, and a fake row there would mislead every reader. */
export const LESSON_SCOPES = [
  'global',
  'repid-engine',
  'hal',
  'anfis',
  'zkp',
] as const;

export type LessonScope = (typeof LESSON_SCOPES)[number];

export interface MemoryNode {
  id: string;
  /** null for scoped (agent-independent) nodes — see `scope`. */
  agent_id: string | null;
  /** Non-null marks an agent-independent node. Exactly one of agent_id/scope
   *  is set in practice; the DB enforces that at least one is. */
  scope?: string | null;
  node_type: NodeType;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  source_event_id: number | null;
  importance: number;
  created_at: string;
  accessed_at: string;
  access_count: number;
}

export interface MemoryEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RetrievalResult {
  node: MemoryNode;
  similarity: number;
  related_nodes: Array<{
    node: MemoryNode;
    edge_type: EdgeType;
    weight: number;
  }>;
}

export interface RetrievalOptions {
  agent_id: string;
  query: string;
  top_k?: number;
  similarity_threshold?: number;
  include_related?: boolean;
  node_types?: NodeType[];
}

/** Same shape as RetrievalOptions with `scope` in place of `agent_id`. Backed by
 *  the graph_rag_match_scoped RPC; graph_rag_match_nodes is left untouched
 *  because it has live callers. */
export interface ScopedRetrievalOptions {
  scope: string;
  query: string;
  top_k?: number;
  similarity_threshold?: number;
  include_related?: boolean;
  node_types?: NodeType[];
}
