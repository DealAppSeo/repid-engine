# HAL runtime-config seed — `repid_config` (2026-07-05)

This is the **seed block** referenced by `src/hal/config.ts` (module docstring:
"Seeding / changing rows is done out-of-band via SQL"). `getHalConfig()` reads
these keys from `repid_config` with **DB → env → default** precedence, cached
in-memory (TTL, default 45s). Changing a row here re-tunes HAL within ~one TTL
window with **NO Railway redeploy**.

## Recommended seed

The one deliberate change vs. today's defaults is `HAL_S2_ENABLE_CEREBRAS='false'`.

**Why disable cerebras:** the cheapest-first quorum assembly
(`src/hal/fact-check.ts`, `factCheck()` ~L412-425) calls providers in cost waves
— **free → cheap → escalation** — and stops the moment `>= 2` distinct model
families respond. With cerebras ON, the free wave is `groq (llama) + cerebras
(glm)` = **2 families**, so assembly **stops in the free wave** and never reaches
the cheap (deepseek) wave. That live pair (groq+cerebras) measures **F1 ≈ 0.34**.
Disabling cerebras makes the free wave `groq` alone = **1 family**, so assembly
**escalates to the deepseek (cheap) wave**, forming **groq+deepseek** (**F1 ≈
0.79**). deepseek must be enabled + funded for the escalation to actually add a
second family; if it isn't, the quorum stays at 1 family and the resilience gate
downgrades any veto to `clean` (fail-safe), rather than firing off a weak pair.

```sql
-- HAL runtime config seed (idempotent). Values are TEXT; 'true'/'false'/'1'/'0'
-- and '2' are the recognized tokens (see parseBool / strictness handling in
-- src/hal/config.ts). Omit any row to let env/default win for that knob.
INSERT INTO repid_config (key, value) VALUES
  -- Provider quorum: groq always-on (host); cerebras OFF so the free wave is
  -- 1 family and assembly escalates to deepseek → groq+deepseek (F1 ~0.79).
  ('HAL_S2_ENABLE_GROQ',      'true'),
  ('HAL_S2_ENABLE_CEREBRAS',  'false'),   -- <-- the fix: drop the weak 2nd free family
  ('HAL_S2_ENABLE_DEEPSEEK',  'true'),    -- cheap paid anchor; must be funded to join
  ('HAL_S2_ENABLE_FIREWORKS', 'false'),
  ('HAL_S2_ENABLE_GEMINI',    'false'),
  ('HAL_S2_ENABLE_MISTRAL',   'false'),
  ('HAL_S2_ENABLE_QWEN',      'false'),
  ('HAL_S2_ENABLE_ANTHROPIC', 'false'),
  -- Pipeline strictness: 2 = cross-LLM fact-check (the discriminative path).
  ('HAL_STRICTNESS',              '2'),
  -- Quorum gates (fail-safe ON): a decision/penalty needs a real >=2-family quorum.
  ('HAL_DECISION_REQUIRES_QUORUM','true'),
  ('HAL_PENALTY_REQUIRES_QUORUM', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

## Escalation trace (cerebras OFF + deepseek ON)

`factCheck()` builds `waves = [free, cheap, escalation]` (non-empty waves only),
then for each wave: `settle(wave)` → if `distinctFamilies(verdicts) >= 2`, break.

- Provider set (built by `buildFactCheckProvidersWith`): `groq` (tier `free`,
  family `llama`), `deepseek` (tier `cheap`, family `deepseek`). cerebras absent
  (flag false).
- **Wave 0 (free)** = `[groq]`. After settle: 1 distinct family (`llama`).
  `1 >= 2` is **false** → do **not** break → continue.
- **Wave 1 (cheap)** = `[deepseek]`. After settle: families now `{llama,
  deepseek}` = **2** → `2 >= 2` true → **break**. **groq+deepseek quorum forms.**
- Escalation wave (fireworks/anthropic/etc.) is never reached — correct
  (all disabled anyway).

Contrast — cerebras ON (today): Wave 0 (free) = `[groq, cerebras]` → families
`{llama, glm}` = 2 → breaks in the free wave, deepseek is never called. That is
the bug this seed fixes.

**Ordering note:** the tier of each provider is read from `p.tier` when set, else
derived by `costTierOf()`. `buildFactCheckProvidersWith` sets `tier` on none of
these, so the derivation runs: `costTierOf` returns `free` for groq (matches
`/groq|...|llama/`) and `cheap` for deepseek (matches `/deepseek/`). So groq
lands in wave 0 and deepseek in wave 1 as required. deepseek's `family:
'deepseek'` is set explicitly at push time, so `distinctFamilies` counts it as a
separate family from groq's `llama`. No subtlety beyond that.

## Reversal

- Re-enable cerebras: `UPDATE repid_config SET value='true' WHERE
  key='HAL_S2_ENABLE_CEREBRAS';` (or delete the row → falls back to env, then to
  the default `true`).
- Disable the whole DB-config layer: set env `HAL_CONFIG_FROM_DB=false` (resolves
  from env/default only — cerebras then defaults ON again via
  `HAL_S2_ENABLE_CEREBRAS !== 'false'`).
