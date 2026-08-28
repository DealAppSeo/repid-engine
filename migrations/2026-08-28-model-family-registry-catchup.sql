-- MODEL FAMILY REGISTRY — CATCH-UP SEED (2026-08-28)
-- OUTPUT_PATH: migrations/2026-08-28-model-family-registry-catchup.sql
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
-- ==========================================================================================
--
-- WHY THIS EXISTS. migrations/2026-07-05-model-family-registry.sql seeded 22 rows and says the code
-- module "mirrors it". The code module says it is "kept byte-aligned with the migration seed so DB
-- and code cannot drift". Both were true when written. Since then SEVEN rows were added to the code
-- seed and none to any migration, so the two had already drifted — while a comment asserted they
-- could not. The runtime is unaffected (the code module is explicitly the authority until the table
-- is applied, and it may not exist in prod at all); what was broken is the claim.
--
-- This file is additive and idempotent: it inserts only the rows added after 2026-07-05 and does
-- nothing to any row already present. It creates nothing and drops nothing.
--
-- THE THREE 2026-08-28 ROWS ARE THE INTERESTING ONES. They are the exact ids a LIVE production
-- quorum reported in `families_unmapped` that day — i.e. every vote in that panel had its family
-- regex-guessed rather than looked up. Two of them reached the panel by paths that did not exist
-- when this table was last edited: 'openai/gpt-oss-20b' is groq's migration target after
-- llama-3.1-8b-instant was shut down, and 'deepseek-v4-flash' was selected AUTOMATICALLY by catalog
-- self-healing. The panel's model set now changes without a commit, so a hand-maintained registry
-- falls behind by default rather than by neglect — worth knowing before the next id lands here.
--
-- 'gemini-2.5-flash' is a near-miss rather than an absence: 'models/gemini-2.5-flash' was already
-- seeded, but the catalog parser strips Google's 'models/' prefix because the completion endpoint
-- rejects it, so the registry held the id in the one form the caller never sends.
--
-- source='hal-config-default' on every row below: these are configured/selected model strings with
-- no telemetry rows at seed time (evidence_n=0), which is the same honest provenance marker the
-- existing HAL-default rows carry. NO INVENTED FAMILIES — each was checked with matchedFamilies()
-- and resolves to exactly one known family.

INSERT INTO model_family_registry (provider, model, family, source, evidence_n) VALUES
  -- added 2026-08-06: caught by the 99-row frozen-corpus holdout answering inside a LIVE quorum
  -- with a regex-guessed (spoofable) family.
  ('openrouter',        'google/gemini-3.5-flash',              'gemini',    'hal-config-default', 0),
  ('openrouter',        'qwen/qwen-2.5-72b-instruct',           'qwen',      'hal-config-default', 0),
  -- added with the Z.AI direct route: a SECOND route to the glm family. Registered so it resolves
  -- to 'glm' rather than reporting unverified — a second route to a family must never read as a
  -- second family, or quorum-diversity counts an echo as a witness.
  ('zai',               'glm-4.5-flash',                        'glm',       'hal-config-default', 0),
  ('zai',               'glm-4.7',                              'glm',       'hal-config-default', 0),
  -- added 2026-08-28: measured unmapped in a live production quorum (see header).
  ('groq',              'openai/gpt-oss-20b',                   'openai',    'hal-config-default', 0),
  ('deepseek',          'deepseek-v4-flash',                    'deepseek',  'hal-config-default', 0),
  ('gemini',            'gemini-2.5-flash',                     'gemini',    'hal-config-default', 0)
ON CONFLICT (provider, model) DO NOTHING;

-- POST-APPLY VERIFY:
-- SELECT count(*) FROM model_family_registry;  -- expect 29 (22 original + 7 here)
-- SELECT family, count(*) FROM model_family_registry GROUP BY family ORDER BY 2 DESC;

-- ROLLBACK (removes ONLY the rows this file adds; leaves the 2026-07-05 seed intact):
-- DELETE FROM model_family_registry WHERE (provider, model) IN (
--   ('openrouter','google/gemini-3.5-flash'), ('openrouter','qwen/qwen-2.5-72b-instruct'),
--   ('zai','glm-4.5-flash'), ('zai','glm-4.7'), ('groq','openai/gpt-oss-20b'),
--   ('deepseek','deepseek-v4-flash'), ('gemini','gemini-2.5-flash'));
