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

export interface MemoryNode {
  id: string;
  agent_id: string;
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
