# HYP-5 CALLSITES inventory (tests + inventory only)

Linear: HYP-5 — P0: Shrink CALLSITES → 0.
Branch: `feat/hyp-5-egress-inventory` off `main`.
Date: 2026-09-09.
This commit does **not** change live egress. No caller was rerouted. `CALLSITE_CEILING` stays 12.

Source of truth: `tests/provider-egress-guard.test.ts` (`CALLSITES`, `CALLSITE_CEILING = 12`, `CALLSITE_HOSTS`).

Linear said 13 → 0. Tree today: **12** callsites (one already retired: `src/selfhost.ts`, 2026-09-09). Remaining shrink is out of this sprint — wrapping callers would change live egress.

## Roles (unchanged)

| Role | Count | May shrink? |
|---|---|---|
| ADAPTER | 10 | no |
| PROBE | 1 | no |
| NOISE | 2 | no |
| CALLSITE | 12 | yes, later |

## CALLSITES and named hosts (layer 1 hostname grep)

| File | Hosts named |
|---|---|
| `src/engine/badges.ts` | api.cerebras.ai |
| `src/hal/classifier.ts` | api.groq.com |
| `src/hal/completeness.ts` | api.groq.com |
| `src/hal/crag.ts` | openrouter.ai, generativelanguage.googleapis.com |
| `src/hal/cross-llm-client.ts` | anthropic, cerebras, deepseek, fireworks, groq, openai |
| `src/hal/fact-check.ts` | anthropic, cerebras, deepseek, fireworks, groq, mistral, z.ai, dashscope, googleapis, nvidia, openrouter |
| `src/hal/lib/clients/embedding.ts` | api.openai.com |
| `src/hal/lib/cross-llm/embedding-client.ts` | api.openai.com (comment) |
| `src/hal/lib/cross-llm/index.ts` | anthropic, cerebras, deepseek, fireworks, groq |
| `src/services/adversarial-judge.ts` | anthropic, cerebras, deepseek, groq, openai, googleapis — **does not honour LOCAL_LLM_BASE_URL** |
| `src/services/pcp-validator.ts` | api.groq.com |
| `src/services/validation-repid-delta.ts` | api.cerebras.ai, api.groq.com |

Knowing a hostname is not presenting a bearer. Layer 2 (SDK constructors) and layer 3 (`src/egress/provider-fetch.ts`) are NOT CHECKED and not built here (new folder would stop LOOP SPRINTS).

## Done for this sprint

- Host inventory pinned in the guard test. A new host in a CALLSITE fails CI. A new CALLSITE still fails the existing ratchet.
- Live fetch paths untouched.

## Not done (HYP-5 remaining)

- Drive CALLSITES 12 → 0 by importing a registry / chokepoint. That is the rest of HYP-5 and changes live egress. Out of this loop's "tests + inventory only".
