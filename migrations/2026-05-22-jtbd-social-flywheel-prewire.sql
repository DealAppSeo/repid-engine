-- Migration: Jobs-to-be-Done & Social Flywheel Pre-Wiring
-- Date: 2026-05-22
-- Author: Sean / Gemini

-- ==========================================
-- 1. Create Tables
-- ==========================================

-- job_templates: defines the menu of "useful tasks" agents can perform
CREATE TABLE IF NOT EXISTS job_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  estimated_value_usd NUMERIC,
  agent_handlers TEXT[],  -- which agents can perform this
  share_template TEXT,    -- prompt for post-completion share
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- user_jobs: tracks useful tasks started/completed by users
CREATE TABLE IF NOT EXISTS user_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,  -- references auth.users(id)
  job_template_id UUID NOT NULL REFERENCES job_templates(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  value_delivered JSONB,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  share_eligible BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_jobs_user_status ON user_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_jobs_share_eligible 
  ON user_jobs(share_eligible, completed_at) 
  WHERE share_eligible = TRUE AND status = 'completed';

-- onboarding_states: tracks Angle A+C onboarding state machine
CREATE TABLE IF NOT EXISTS onboarding_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE, -- references auth.users(id)
  ephemeral_wallet_address TEXT,
  useful_task_completed_id UUID REFERENCES user_jobs(id),
  credential_minted BOOLEAN DEFAULT FALSE,
  upgraded_to_permanent_wallet BOOLEAN DEFAULT FALSE,
  conversion_funnel_stage TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_funnel ON onboarding_states(conversion_funnel_stage);

-- ==========================================
-- 2. Augment Existing Tables
-- ==========================================

-- Augment existing shares for general job-attribution
ALTER TABLE shares 
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES user_jobs(id),
  ADD COLUMN IF NOT EXISTS share_url_destination TEXT,
  ADD COLUMN IF NOT EXISTS claim_count INTEGER DEFAULT 0;

-- Augment existing referrals for source-attribution
ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS source_job_id UUID REFERENCES user_jobs(id),
  ADD COLUMN IF NOT EXISTS source_share_id BIGINT REFERENCES shares(id);

-- ==========================================
-- 3. Create Views
-- ==========================================

-- Flat read-only source for viral loop analytics
CREATE OR REPLACE VIEW viral_loop_events AS
SELECT 
  uj.id AS job_id,
  uj.user_id AS source_user_id,
  uj.completed_at AS job_completed_at,
  s.id AS share_id,
  s.platform AS share_platform,
  s.clicks AS share_clicks,
  s.claim_count AS share_claims,
  r.id AS referral_id,
  r.referred_user_id AS converted_user_id,
  r.signup_completed_at AS conversion_at
FROM user_jobs uj
LEFT JOIN shares s ON s.job_id = uj.id
LEFT JOIN referrals r ON r.source_share_id = s.id
WHERE uj.status = 'completed';

-- ==========================================
-- 4. Enable Row Level Security (RLS)
-- ==========================================

ALTER TABLE job_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_chains ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- 5. RLS Policies
-- ==========================================

-- job_templates: public read-only
CREATE POLICY job_templates_public_read ON job_templates FOR SELECT USING (TRUE);

-- user_jobs: own only
CREATE POLICY user_jobs_select_own ON user_jobs FOR SELECT 
  USING (auth.uid() = user_id);
CREATE POLICY user_jobs_insert_own ON user_jobs FOR INSERT 
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_jobs_update_own ON user_jobs FOR UPDATE 
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- onboarding_states: own only
CREATE POLICY onboarding_states_select_own ON onboarding_states FOR SELECT 
  USING (auth.uid() = user_id);
CREATE POLICY onboarding_states_update_own ON onboarding_states FOR UPDATE 
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY onboarding_states_insert_own ON onboarding_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- shares: public select, authenticated insert/update for own jobs
CREATE POLICY shares_select_public ON shares FOR SELECT USING (TRUE);
CREATE POLICY shares_insert_authenticated ON shares FOR INSERT TO authenticated 
  WITH CHECK (
    job_id IS NULL OR EXISTS (
      SELECT 1 FROM user_jobs 
      WHERE user_jobs.id = job_id 
        AND user_jobs.user_id = auth.uid()
    )
  );
CREATE POLICY shares_update_authenticated ON shares FOR UPDATE TO authenticated 
  USING (
    job_id IS NULL OR EXISTS (
      SELECT 1 FROM user_jobs 
      WHERE user_jobs.id = job_id 
        AND user_jobs.user_id = auth.uid()
    )
  )
  WITH CHECK (
    job_id IS NULL OR EXISTS (
      SELECT 1 FROM user_jobs 
      WHERE user_jobs.id = job_id 
        AND user_jobs.user_id = auth.uid()
    )
  );

-- invites (existing table): enable SELECT for validity check, INSERT/UPDATE for authenticated users
CREATE POLICY invites_select_public ON invites FOR SELECT USING (TRUE);
CREATE POLICY invites_insert_authenticated ON invites FOR INSERT TO authenticated WITH CHECK (TRUE);
CREATE POLICY invites_update_authenticated ON invites FOR UPDATE TO authenticated USING (TRUE);

-- invite_chains: public select, service_role write
CREATE POLICY invite_chains_select_public ON invite_chains FOR SELECT USING (TRUE);

-- ==========================================
-- 6. Table & Column Comments
-- ==========================================

COMMENT ON TABLE job_templates IS 'Menu of available jobs-to-be-done that agents can perform. Added 2026-05-22.';
COMMENT ON TABLE user_jobs IS 'Jobs started or completed by users. Checked by frontend to display user achievements. Added 2026-05-22.';
COMMENT ON TABLE onboarding_states IS 'Tracks onboarding funnel stage for Angle A+C synthesis. Added 2026-05-22.';
COMMENT ON VIEW viral_loop_events IS 'Unified view for frontend social sharing and conversion statistics. Added 2026-05-22.';
