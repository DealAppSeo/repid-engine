CREATE TABLE public.llm_call_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('0a','0b','1')),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  user_id UUID,
  agent_id UUID,
  task_hint TEXT,
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','rate_limited','cap_hit')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_call_log_provider_created ON public.llm_call_log(provider, created_at DESC);
CREATE INDEX idx_llm_call_log_user ON public.llm_call_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_llm_call_log_agent ON public.llm_call_log(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE public.llm_provider_caps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK (tier IN ('0a','0b','1')),
  monthly_limit_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  current_month_spent_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  hard_disabled BOOLEAN NOT NULL DEFAULT false,
  last_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS posture: server-only (service role bypasses)
ALTER TABLE public.llm_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_provider_caps ENABLE ROW LEVEL SECURITY;
-- No policies = locked except via service role

-- Seed initial caps (Sean's recommended starter values)
INSERT INTO public.llm_provider_caps (provider, tier, monthly_limit_usd, notes) VALUES
  ('groq', '0a', 0, 'Free tier, no $$ cap, only rate limits'),
  ('cerebras', '0a', 0, 'Free tier'),
  ('gemini', '0a', 0, 'Free tier'),
  ('cohere', '0a', 0, 'Free tier'),
  ('deepseek', '0a', 0, 'Free trial'),
  ('anthropic', '1', 0, 'BYOK only, user pays'),
  ('openai', '1', 0, 'BYOK only, user pays');
