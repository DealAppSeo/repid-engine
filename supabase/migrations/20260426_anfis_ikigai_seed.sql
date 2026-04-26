-- ============================================================================
-- ANFIS-Ikigai v0 — Seed data
--
-- Seeds (1) the v0 rule base into anfis_rule_base, and (2) Sean's first
-- IkigaiProfile from session memory. Sean should review and refine; v1 will
-- replace this with proper onboarding.
--
-- All inserts are guarded by NOT EXISTS so re-running the migration is safe.
-- ============================================================================

-- ----- 1. Seed Sean's dogfood ikigai profile --------------------------------
INSERT INTO ikigai_profiles (
  user_id,
  profile_version,
  love_dimension,
  good_at_dimension,
  world_needs_dimension,
  paid_for_dimension,
  active
)
SELECT
  'sean',
  1,
  jsonb_build_object('keywords', jsonb_build_array(
    'Trivergence',
    'AI plus Blockchain plus Quantum',
    'constitutional AI',
    'agent reputation',
    'ZKP',
    'multi-agent systems',
    'biblical exegesis'
  )),
  jsonb_build_object('keywords', jsonb_build_array(
    'systems architecture',
    'patent strategy',
    'multi-AI orchestration',
    'ANFIS routing',
    'blockchain integration'
  )),
  jsonb_build_object('keywords', jsonb_build_array(
    'safe and ethical AI',
    'anti-deepfake infrastructure',
    'agent accountability',
    'democratized financial inclusion',
    'creator economy fairness'
  )),
  jsonb_build_object('keywords', jsonb_build_array(
    'enterprise AI governance',
    'agent identity infrastructure',
    'RepID licensing',
    'TrustMarket marketplace fees',
    'x402 payment routing'
  )),
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ikigai_profiles
  WHERE user_id = 'sean' AND profile_version = 1
);

-- ----- 2. Seed the v0 rule base ---------------------------------------------
-- Each rule_json mirrors the IkigaiRule shape in src/services/anfis-ikigai-rules.ts.
-- The TS rule base is the source of truth at runtime; this seed keeps the DB
-- in sync so the rule library can be queried, browsed, and (in v1) updated
-- without redeploying.

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF love=high AND good_at=high AND world_needs=high AND paid_for=high THEN composite_score = 0.95',
  '{"id":"R1_full_ikigai","antecedents":[{"dimension":"love","fuzzySet":"high"},{"dimension":"good_at","fuzzySet":"high"},{"dimension":"world_needs","fuzzySet":"high"},{"dimension":"paid_for","fuzzySet":"high"}],"consequent":0.95,"explanation":"Rare four-circle convergence. Highest priority surface."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R1_full_ikigai');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF love=high AND good_at=high AND world_needs=medium THEN composite_score = 0.80',
  '{"id":"R2_vocation","antecedents":[{"dimension":"love","fuzzySet":"high"},{"dimension":"good_at","fuzzySet":"high"},{"dimension":"world_needs","fuzzySet":"medium"}],"consequent":0.80,"explanation":"Strong personal-skills alignment with moderate external need."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R2_vocation');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF love=high AND world_needs=high THEN composite_score = 0.75',
  '{"id":"R3_mission","antecedents":[{"dimension":"love","fuzzySet":"high"},{"dimension":"world_needs","fuzzySet":"high"}],"consequent":0.75,"explanation":"Heart and impact, regardless of skill or pay."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R3_mission');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF good_at=high AND paid_for=high THEN composite_score = 0.65',
  '{"id":"R4_profession","antecedents":[{"dimension":"good_at","fuzzySet":"high"},{"dimension":"paid_for","fuzzySet":"high"}],"consequent":0.65,"explanation":"Skill plus sustainability with lower meaning."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R4_profession');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF love=high AND good_at=medium THEN composite_score = 0.55',
  '{"id":"R5_passion","antecedents":[{"dimension":"love","fuzzySet":"high"},{"dimension":"good_at","fuzzySet":"medium"}],"consequent":0.55,"explanation":"Energy plus capability gap. Worth surfacing because growth is likely."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R5_passion');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF love=high AND good_at=low AND world_needs=low THEN composite_score = 0.20',
  '{"id":"R6_engagement_trap","antecedents":[{"dimension":"love","fuzzySet":"high"},{"dimension":"good_at","fuzzySet":"low"},{"dimension":"world_needs","fuzzySet":"low"}],"consequent":0.20,"explanation":"Engaging but unproductive. Anti-engagement-economy filter."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R6_engagement_trap');

INSERT INTO anfis_rule_base (rule_text, rule_json, weight, active)
SELECT
  'IF good_at=high AND paid_for=high AND love=low AND world_needs=low THEN composite_score = 0.30',
  '{"id":"R7_burnout","antecedents":[{"dimension":"good_at","fuzzySet":"high"},{"dimension":"paid_for","fuzzySet":"high"},{"dimension":"love","fuzzySet":"low"},{"dimension":"world_needs","fuzzySet":"low"}],"consequent":0.30,"explanation":"Pure transactional alignment with high burnout risk."}'::jsonb,
  1.0,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM anfis_rule_base WHERE rule_json->>'id' = 'R7_burnout');
