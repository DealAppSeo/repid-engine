-- ================================================================
-- CC Sprint 2 Arc C — feedback_events table prep for Stage 1.5
-- 2026-05-11
-- ================================================================
-- Lays the schema down now so Stage 1.5 (human-feedback surfaces:
-- GitHub Discussions, Discord, AIDebate.io, in-app) doesn't need a
-- migration sprint when it ships. No code is written against this
-- table yet — Stage 1.5 builds the writers.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.feedback_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN (
    'github_issue', 'github_discussion', 'discord', 'forum', 'aidebate', 'in_app'
  )),
  external_id TEXT,                          -- ID on the source platform (issue #, post ID, etc.)
  external_url TEXT,
  user_handle TEXT,                          -- the person who gave feedback
  user_repid_agent_id UUID REFERENCES public.repid_agents(id),  -- if linked to a HyperDAG agent
  feedback_type TEXT NOT NULL CHECK (feedback_type IN (
    'bug_report', 'feature_request', 'bounty_claim', 'governance_proposal',
    'agent_critique', 'q_and_a', 'general'
  )),
  title TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'accepted', 'rejected', 'duplicate', 'in_progress', 'closed'
  )),
  awarded_repid_delta INTEGER NOT NULL DEFAULT 0,
  awarded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS feedback_events_source_external_idx
  ON public.feedback_events (source, external_id);
CREATE INDEX IF NOT EXISTS feedback_events_user_repid_agent_idx
  ON public.feedback_events (user_repid_agent_id) WHERE user_repid_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feedback_events_status_created_idx
  ON public.feedback_events (status, created_at DESC);
ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;

-- Add optional FK from repid_events to feedback_events so a RepID delta can
-- cite the feedback that earned it.
-- Note: per CLAUDE.md, the canonical RepID audit log is repid_score_events,
-- but the sprint Arc C explicitly references repid_events. The
-- repid_events table also exists (10 cols, generic event log with
-- subject_id text). We add the FK there per the sprint spec; if the
-- canonical RepID linkage should be on repid_score_events instead,
-- a follow-up migration can mirror this column.
ALTER TABLE public.repid_events
  ADD COLUMN IF NOT EXISTS feedback_event_id BIGINT REFERENCES public.feedback_events(id);
CREATE INDEX IF NOT EXISTS repid_events_feedback_event_idx
  ON public.repid_events (feedback_event_id) WHERE feedback_event_id IS NOT NULL;

COMMIT;

-- Rollback (run in reverse order — DROPs cascade FK → table):
--   DROP INDEX IF EXISTS public.repid_events_feedback_event_idx;
--   ALTER TABLE public.repid_events DROP COLUMN IF EXISTS feedback_event_id;
--   DROP INDEX IF EXISTS public.feedback_events_status_created_idx;
--   DROP INDEX IF EXISTS public.feedback_events_user_repid_agent_idx;
--   DROP INDEX IF EXISTS public.feedback_events_source_external_idx;
--   DROP TABLE IF EXISTS public.feedback_events;
