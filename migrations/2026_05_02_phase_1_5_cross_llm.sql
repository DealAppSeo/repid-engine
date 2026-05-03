-- HAL Phase 1.5 — Cross-LLM Verification Layer
-- Author: HAL/HAEE
-- Date: 2026-05-02
-- Applied to qnnpjhlxljtqyigedwkb on 2026-05-02 via Supabase MCP.

-- Layer 0 — ANFIS prompt-category classifier outputs.
CREATE TABLE IF NOT EXISTS hal_classifications (
  id BIGSERIAL PRIMARY KEY,
  prompt_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('factual','opinion','math','code','creative','time-sensitive')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  latency_ms INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hal_classifications_hash ON hal_classifications(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_hal_classifications_created ON hal_classifications(created_at DESC);
COMMENT ON TABLE hal_classifications IS 'HAL Phase 1.5 — Layer 0 ANFIS prompt-category classifier outputs.';

-- Layer 1 — Cross-LLM textual comparison outputs.
CREATE TABLE IF NOT EXISTS cross_llm_comparisons (
  id BIGSERIAL PRIMARY KEY,
  prompt_hash TEXT NOT NULL,
  provider_1 TEXT NOT NULL,
  provider_2 TEXT NOT NULL,
  model_1 TEXT,
  model_2 TEXT,
  agreement_score NUMERIC(5,4) NOT NULL CHECK (agreement_score >= 0 AND agreement_score <= 1),
  embedding_distance NUMERIC(7,4) NOT NULL,
  methodology TEXT NOT NULL CHECK (methodology IN ('embedding-cosine','fallback-jaccard')),
  latency_ms INTEGER NOT NULL,
  answer_1_preview TEXT,
  answer_2_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cross_llm_hash ON cross_llm_comparisons(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_cross_llm_created ON cross_llm_comparisons(created_at DESC);
COMMENT ON TABLE cross_llm_comparisons IS 'HAL Phase 1.5 — Layer 1 cross-LLM textual comparison outputs.';
