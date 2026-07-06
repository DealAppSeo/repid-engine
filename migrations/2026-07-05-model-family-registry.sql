-- MODEL FAMILY REGISTRY (Phase 1, CC 2026-07-05)
-- OUTPUT_PATH: migrations/2026-07-05-model-family-registry.sql
-- SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7 (family-disjointness HARD RULE)
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
-- ==========================================================================================
--
-- PURPOSE: the single source of family truth for disjointness lookups. Disjointness must be a
-- REGISTRY LOOKUP, never ad-hoc model-name string parsing at decision time (§7). This table is the
-- durable, auditable seed; the code module (src/decisioning/family-registry.ts) mirrors it and is the
-- runtime authority until this is applied.
--
-- SEED PROVENANCE [V]: every (provider, model) below is an ACTUAL DISTINCT pair in llm_call_log
-- (Supabase qnnpjhlxljtqyigedwkb, COUNT(DISTINCT (provider,model))=27, 2026-07-05). Family is derived
-- from src/hal/fact-check.ts familyOf() (the existing family-truth), traced over each model 2026-07-05.
-- 21 of 27 pairs map to a real family; the 6 that do NOT are OMITTED from the seed and listed in
-- phase1-findings.md for Sean (NO INVENTED FAMILIES). Unmapped => hard-fail at lookup, never a guess.

CREATE TABLE IF NOT EXISTS model_family_registry (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  family        TEXT NOT NULL,           -- the independent model FAMILY (the disjointness key)
  source        TEXT NOT NULL,           -- how the mapping was established (provenance)
  evidence_n    INTEGER,                 -- telemetry row count backing this pair (audit)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model)
);

-- Seed: the 21 confidently-mapped telemetry pairs. source='familyOf' where familyOf() resolved a real
-- family from the model string. evidence_n = telemetry COUNT for that pair [V 2026-07-05].
INSERT INTO model_family_registry (provider, model, family, source, evidence_n) VALUES
  ('groq',              'llama-3.1-8b-instant',                 'llama',     'familyOf', 77536),
  ('cerebras',          'zai-glm-4.7',                          'glm',       'familyOf', 68287),
  ('mistral',           'mistral-small-latest',                 'mistral',   'familyOf', 61974),
  ('gemini',            'gemini-2.0-flash',                     'gemini',    'familyOf', 60767),
  ('fireworks',         'accounts/fireworks/models/kimi-k2p5',  'kimi',      'familyOf', 9713),
  ('cerebras',          'llama3.1-8b',                          'llama',     'familyOf', 9181),
  ('deepseek',          'deepseek-chat',                        'deepseek',  'familyOf', 6386),
  ('openai',            'gpt-4o-mini',                          'openai',    'familyOf', 5073),
  ('deepseek-chat',     'deepseek-chat',                        'deepseek',  'familyOf', 5071),
  ('groq',              'llama-3.3-70b-versatile',              'llama',     'familyOf', 3953),
  ('anthropic',         'claude-haiku-4-5-20251001',            'anthropic', 'familyOf', 3351),
  ('litellm',           'hf/qwen-2.5-72b',                      'qwen',      'familyOf', 3177),
  ('gemini',            'models/gemini-2.5-flash',              'gemini',    'familyOf', 3144),
  ('litellm',           'hf/deepseek-r1-qwen-32b',              'deepseek',  'familyOf', 1878),
  ('deepseek-reasoner', 'deepseek-reasoner',                    'deepseek',  'familyOf', 460),
  ('groq-70b',          'llama-3.3-70b-versatile',              'llama',     'familyOf', 331),
  ('groq-8b',           'llama-3.1-8b-instant',                 'llama',     'familyOf', 331),
  ('gpt-4o-mini',       'gpt-4o-mini',                          'openai',    'familyOf', 165),
  ('qwen',              'gpt-4o-mini',                          'openai',    'familyOf', 46),
  ('litellm-qwen',      'hf/qwen-2.5-72b',                      'qwen',      'familyOf', 9),
  ('llama-3-2-1b',      'Llama-3.2-1B-Instruct',                'llama',     'familyOf', 3),
  -- CROSS-FIX 2026-07-05: HAL's configured qwen default (HAL_S2_QWEN_MODEL default 'qwen-plus'). No
  -- telemetry at seed time (qwen quorum is opt-in) so source='hal-config-default', evidence_n=0 (honest:
  -- config, not telemetry). Unambiguous /qwen/ match → HAL's live quorum hits the registry, not the regex.
  ('qwen',              'qwen-plus',                            'qwen',      'hal-config-default', 0)
ON CONFLICT (provider, model) DO NOTHING;

-- OMITTED (unmapped — listed for Sean, NOT seeded, hard-fail at lookup):
--   litellm-phi | hf/phi-4-mini            (890)  familyOf -> 'hf' (provider-prefix artifact; real family is Microsoft 'phi',
--                                                  but familyOf() has NO phi rule). PROPOSED addition, awaiting Sean.
--   groq        | test-model               (164)  familyOf -> 'test'    (test sentinel, not a real model)
--   gemini      | test-model               (120)  familyOf -> 'test'    (test sentinel)
--   groq        | unknown                  (44)   familyOf -> 'unknown' (no model string)
--   llama-3-2-1b| unknown                  (3)    familyOf -> 'unknown' (provider implies llama; model col null-ish — NOT guessed)
--   anthropic   | unknown                  (2)    familyOf -> 'unknown' (no model string)

ALTER TABLE model_family_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON model_family_registry;
CREATE POLICY "service_role_all" ON model_family_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE model_family_registry IS
  'Single source of model->family truth for disjointness lookups (§7 HARD RULE). Seed = 21 confidently-mapped telemetry pairs via familyOf(); 6 unmapped pairs omitted + listed for Sean. Unmapped => hard-fail, never guessed. PROMOTION-GATED.';

-- ROLLBACK:
-- DROP POLICY IF EXISTS "service_role_all" ON model_family_registry;
-- DROP TABLE IF EXISTS model_family_registry;

-- POST-APPLY VERIFY:
-- SELECT family, count(*) FROM model_family_registry GROUP BY family ORDER BY 2 DESC;
-- SELECT count(*) FROM model_family_registry;  -- expect 22 (21 telemetry + 1 hal-config-default: qwen-plus)
