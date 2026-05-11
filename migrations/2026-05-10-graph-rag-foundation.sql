-- ============================================================
-- Graph RAG foundation: nodes (with embeddings) + edges
-- Sprint: feat/graph-rag-foundation-2026-05-10 (CC1)
-- ============================================================
-- Pre-state verified 2026-05-10 against project qnnpjhlxljtqyigedwkb:
--   * repid_agents.id is UUID
--   * pgvector extension v0.8.0 installed in schema "public"
--   * No existing tables named agent_memory_nodes / agent_memory_edges
-- ============================================================
BEGIN;

-- Nodes: any piece of agent memory worth retrieving later
CREATE TABLE IF NOT EXISTS agent_memory_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  node_type       TEXT NOT NULL CHECK (node_type IN (
                    'observation', 'decision', 'fact',
                    'preference', 'goal', 'interaction', 'reflection'
                  )),
  content         TEXT NOT NULL,
  embedding       vector(384),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_event_id BIGINT,
  importance      NUMERIC(3,2) NOT NULL DEFAULT 0.50
                    CHECK (importance >= 0 AND importance <= 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_nodes_agent_id
  ON agent_memory_nodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_nodes_type
  ON agent_memory_nodes(node_type);

-- HNSW index for fast vector similarity (cosine)
CREATE INDEX IF NOT EXISTS idx_agent_memory_nodes_embedding_hnsw
  ON agent_memory_nodes
  USING hnsw (embedding vector_cosine_ops);

-- Edges: directed, typed, weighted relationships between nodes
CREATE TABLE IF NOT EXISTS agent_memory_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node_id    UUID NOT NULL REFERENCES agent_memory_nodes(id) ON DELETE CASCADE,
  to_node_id      UUID NOT NULL REFERENCES agent_memory_nodes(id) ON DELETE CASCADE,
  edge_type       TEXT NOT NULL CHECK (edge_type IN (
                    'mentions', 'response_to', 'caused_by',
                    'contradicts', 'reinforces', 'references'
                  )),
  weight          NUMERIC(3,2) NOT NULL DEFAULT 0.50
                    CHECK (weight >= 0 AND weight <= 1),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_edges CHECK (from_node_id != to_node_id),
  CONSTRAINT unique_edge UNIQUE (from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_edges_from
  ON agent_memory_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_edges_to
  ON agent_memory_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_edges_type
  ON agent_memory_edges(edge_type);

-- RLS: agents see only their own memory. Service role bypasses by default
-- (used by backend). Anon gets NOTHING (no policy = deny). Agent-scoped
-- authenticated reads can be added later when there's an end-user surface.
ALTER TABLE agent_memory_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_edges ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- RPC: atomic touch of accessed_at + access_count++
-- Used by RetrievalService to update read stats without round-tripping
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION graph_rag_touch_node(p_node_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE agent_memory_nodes
     SET accessed_at  = NOW(),
         access_count = access_count + 1
   WHERE id = p_node_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- RPC: vector-similarity match scoped to one agent
-- Returns top-K nodes whose cosine similarity to the query embedding
-- meets the similarity threshold. p_node_types = NULL means all types.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION graph_rag_match_nodes(
  p_agent_id UUID,
  p_query_embedding vector(384),
  p_match_count INT DEFAULT 5,
  p_similarity_threshold NUMERIC DEFAULT 0.65,
  p_node_types TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id UUID,
  node_type TEXT,
  content TEXT,
  metadata JSONB,
  source_event_id BIGINT,
  importance NUMERIC,
  created_at TIMESTAMPTZ,
  accessed_at TIMESTAMPTZ,
  access_count INTEGER,
  similarity NUMERIC
) AS $$
  SELECT
    n.id, n.agent_id, n.node_type, n.content, n.metadata,
    n.source_event_id, n.importance,
    n.created_at, n.accessed_at, n.access_count,
    (1 - (n.embedding <=> p_query_embedding))::NUMERIC AS similarity
  FROM agent_memory_nodes n
  WHERE n.agent_id = p_agent_id
    AND n.embedding IS NOT NULL
    AND (p_node_types IS NULL OR n.node_type = ANY(p_node_types))
    AND (1 - (n.embedding <=> p_query_embedding)) >= p_similarity_threshold
  ORDER BY n.embedding <=> p_query_embedding
  LIMIT p_match_count;
$$ LANGUAGE sql STABLE;

COMMIT;

-- ROLLBACK (manual, comment-uncomment to use):
-- BEGIN;
-- DROP FUNCTION IF EXISTS graph_rag_match_nodes(UUID, vector, INT, NUMERIC, TEXT[]);
-- DROP FUNCTION IF EXISTS graph_rag_touch_node(UUID);
-- DROP TABLE IF EXISTS agent_memory_edges;
-- DROP TABLE IF EXISTS agent_memory_nodes;
-- COMMIT;
