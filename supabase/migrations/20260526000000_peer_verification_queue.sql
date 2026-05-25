-- Create peer_verification_queue table
CREATE TABLE IF NOT EXISTS public.peer_verification_queue (
  id BIGSERIAL PRIMARY KEY,
  source_response_id UUID NOT NULL,
  source_agent_id UUID NOT NULL,
  certainty_at_claim DOUBLE PRECISION NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'in_review', 'verified', 'disputed', 'timeout')),
  verifier_agent_id UUID,
  verifier_response_id UUID,
  verifier_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  threshold_used DOUBLE PRECISION NOT NULL,
  claim_text TEXT
);

-- Enable Row Level Security
ALTER TABLE public.peer_verification_queue ENABLE ROW LEVEL SECURITY;

-- Allow select and modifications
DROP POLICY IF EXISTS peer_verification_queue_select ON public.peer_verification_queue;
CREATE POLICY peer_verification_queue_select ON public.peer_verification_queue
  FOR SELECT USING (true);

DROP POLICY IF EXISTS peer_verification_queue_all ON public.peer_verification_queue;
CREATE POLICY peer_verification_queue_all ON public.peer_verification_queue
  FOR ALL USING (true) WITH CHECK (true);

-- PG trigger on repid_score_events to automatically enqueue low certainty claims
CREATE OR REPLACE FUNCTION public.trg_repid_score_events_peer_verify()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.certainty_at_claim IS NOT NULL AND NEW.certainty_at_claim < 0.85 THEN
    -- Prevent duplicate enqueues for the same response/llm_call_id
    IF NOT EXISTS (
      SELECT 1 FROM public.peer_verification_queue 
      WHERE source_response_id = NEW.llm_call_id
    ) THEN
      INSERT INTO public.peer_verification_queue (
        source_response_id,
        source_agent_id,
        certainty_at_claim,
        verification_status,
        threshold_used,
        claim_text,
        created_at
      ) VALUES (
        COALESCE(NEW.llm_call_id, '00000000-0000-0000-0000-000000000000'::uuid),
        NEW.agent_id,
        NEW.certainty_at_claim,
        'pending',
        0.85,
        COALESCE(NEW.answer_text, NEW.prompt_text, ''),
        NOW()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS repid_score_events_peer_verify_trigger ON public.repid_score_events;

CREATE TRIGGER repid_score_events_peer_verify_trigger
AFTER INSERT ON public.repid_score_events
FOR EACH ROW
EXECUTE FUNCTION public.trg_repid_score_events_peer_verify();
