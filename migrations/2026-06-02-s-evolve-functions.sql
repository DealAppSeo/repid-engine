-- ============================================================================
-- S-EVOLVE Migration — tables, capabilities columns, and stored functions
-- June 1, 2026 (PDT)
-- ============================================================================


-- 1. capabilities column on repid_agents
ALTER TABLE public.repid_agents ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}';

-- 2. hallucination_fingerprints table
CREATE TABLE IF NOT EXISTS public.hallucination_fingerprints (
  id SERIAL PRIMARY KEY,
  pattern_id TEXT UNIQUE NOT NULL,
  description TEXT,
  signal_signature JSONB NOT NULL,
  provider_frequency JSONB DEFAULT '{}',
  topic_keywords TEXT[] DEFAULT '{}',
  detection_rate NUMERIC(5,4) DEFAULT 1.0,
  false_positive_rate NUMERIC(5,4) DEFAULT 0.0,
  sample_count INTEGER DEFAULT 0,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.hallucination_fingerprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.hallucination_fingerprints;
CREATE POLICY "service_role_all" ON public.hallucination_fingerprints FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. agent_mentorships table
CREATE TABLE IF NOT EXISTS public.agent_mentorships (
  id SERIAL PRIMARY KEY,
  mentor_agent TEXT NOT NULL,
  mentee_agent TEXT NOT NULL,
  domain TEXT,
  mentee_improvement_rate NUMERIC(5,4) DEFAULT 0,
  sessions_completed INTEGER DEFAULT 0,
  mentor_repid_earned NUMERIC DEFAULT 0,
  mentee_repid_earned NUMERIC DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.agent_mentorships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_mentorships;
CREATE POLICY "service_role_all" ON public.agent_mentorships FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. agent_learning_events table
CREATE TABLE IF NOT EXISTS public.agent_learning_events (
  id BIGSERIAL PRIMARY KEY,
  source_agent TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'hallucination_caught', 'hallucination_missed', 'pattern_discovered',
    'capability_unlocked', 'mentorship_session', 'escalation_resolved',
    'challenge_won', 'challenge_lost', 'new_fingerprint'
  )),
  lesson TEXT NOT NULL,
  evidence JSONB,
  applicable_agents TEXT[] DEFAULT '{}',
  confidence NUMERIC(5,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.agent_learning_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.agent_learning_events;
CREATE POLICY "service_role_all" ON public.agent_learning_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. fn_agent_performance function
CREATE OR REPLACE FUNCTION public.fn_agent_performance(
  p_agent_name TEXT,
  p_period INTERVAL DEFAULT '24 hours'
) RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_completed INTEGER;
  v_failed INTEGER;
  v_shadow INTEGER;
  v_total INTEGER;
  v_agent_id UUID;
BEGIN
  -- Resolve agent UUID
  SELECT id INTO v_agent_id FROM public.repid_agents WHERE agent_name = p_agent_name LIMIT 1;
  
  SELECT 
    COUNT(*) FILTER (WHERE status = 'done' OR status = 'completed'),
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*) FILTER (WHERE status = 'shadow_reject'),
    COUNT(*)
  INTO v_completed, v_failed, v_shadow, v_total
  FROM public.trinity_tasks
  WHERE claimed_by = p_agent_name
  AND updated_at > NOW() - p_period;
  
  v_result := jsonb_build_object(
    'agent_name', p_agent_name,
    'tasks_completed', v_completed,
    'tasks_failed', v_failed,
    'tasks_shadow_rejected', v_shadow,
    'completion_rate', CASE WHEN v_total > 0 
      THEN ROUND(100.0 * v_completed / v_total, 1) ELSE 0.0 END,
    'escalation_rate', CASE WHEN v_total > 0 THEN (
      SELECT ROUND(100.0 * COUNT(*) / GREATEST(v_total, 1), 1)
      FROM public.task_escalations 
      WHERE original_agent = p_agent_name
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'avg_cost_usd', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT COALESCE(ROUND(AVG(COALESCE(cost_usd, 0)), 6), 0.0)
      FROM public.llm_call_log
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'avg_latency_ms', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT COALESCE(ROUND(AVG(COALESCE(latency_ms, 0)), 1), 0.0)
      FROM public.llm_call_log
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'hal_catch_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE hallucination_caught = true) / COUNT(*), 1)
        ELSE 0.0 END
      FROM public.repid_score_events
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'false_positive_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) FILTER (WHERE hal_decision = 'vetoed') > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE hal_decision = 'vetoed' AND (metadata->>'disputed')::boolean = true) / COUNT(*) FILTER (WHERE hal_decision = 'vetoed'), 1)
        ELSE 0.0 END
      FROM public.repid_score_events
      WHERE agent_id = v_agent_id
      AND created_at > NOW() - p_period
    ) ELSE 0.0 END,
    'peer_agreement_rate', CASE WHEN v_agent_id IS NOT NULL THEN (
      SELECT CASE WHEN COUNT(*) > 0
        THEN ROUND(100.0 * COUNT(*) FILTER (WHERE verification_status = 'verified') / COUNT(*), 1)
        ELSE 100.0 END
      FROM public.peer_verification_queue
      WHERE source_agent_id = v_agent_id
      AND completed_at > NOW() - p_period
    ) ELSE 100.0 END
  );
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- 6. fn_daily_agent_review function
CREATE OR REPLACE FUNCTION public.fn_daily_agent_review()
RETURNS void AS $$
DECLARE
  v_agent RECORD;
BEGIN
  FOR v_agent IN 
    SELECT DISTINCT claimed_by FROM public.trinity_tasks 
    WHERE claimed_by IS NOT NULL 
    AND updated_at > NOW() - INTERVAL '24 hours'
  LOOP
    -- Generate performance summary
    INSERT INTO public.agent_learning_events (source_agent, event_type, lesson, evidence, confidence)
    SELECT 
      v_agent.claimed_by,
      'pattern_discovered',
      format('24h summary: %s tasks done, %s failed, %s shadow_reject. Completion rate: %s%%',
        COUNT(*) FILTER (WHERE status = 'done' OR status = 'completed'),
        COUNT(*) FILTER (WHERE status = 'failed'),
        COUNT(*) FILTER (WHERE status = 'shadow_reject'),
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'done' OR status = 'completed') / GREATEST(COUNT(*), 1), 1)
      ),
      jsonb_build_object(
        'done', COUNT(*) FILTER (WHERE status = 'done' OR status = 'completed'),
        'failed', COUNT(*) FILTER (WHERE status = 'failed'),
        'shadow', COUNT(*) FILTER (WHERE status = 'shadow_reject')
      ),
      0.9
    FROM public.trinity_tasks
    WHERE claimed_by = v_agent.claimed_by
    AND updated_at > NOW() - INTERVAL '24 hours';
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Schedule daily at 7am PDT (2pm UTC)
-- Note: Check if pg_cron is enabled/installed in public schema or cron schema. 
-- We try to schedule it if the pg_cron extension is active.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('daily-agent-review', '0 14 * * *', 'SELECT public.fn_daily_agent_review()');
  END IF;
END $$;

