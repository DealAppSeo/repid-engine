# Phase 1 — ANFIS Decisioning Contracts — Findings

SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7 (family-disjointness HARD RULE)
Branch: `feat/cc-2026-07-05-decisioning-phase1-contracts`

## Family registry seed — provenance
The runtime family registry (`src/decisioning/family-registry.ts`) and its mirror migration
(`migrations/2026-07-05-model-family-registry.sql`) seed **21 confidently-mapped (provider, model)
pairs**, each an ACTUAL DISTINCT pair in `llm_call_log` (Supabase qnnpjhlxljtqyigedwkb;
`COUNT(DISTINCT (provider,model)) = 27`, 2026-07-05). Family derived by tracing `familyOf()`
(`src/hal/fact-check.ts`) over each model. No invented families.

### 6 unmapped telemetry pairs (OMITTED from seed, listed for Sean — never guessed)
| provider | model | familyOf() | note |
|---|---|---|---|
| litellm-phi | hf/phi-4-mini | `hf` | real family is Microsoft `phi`; familyOf() has NO phi rule. PROPOSED addition, awaiting Sean. |
| groq | test-model | `test` | test sentinel, not a real model |
| gemini | test-model | `test` | test sentinel |
| groq | unknown | `unknown` | no model string |
| llama-3-2-1b | unknown | `unknown` | provider implies llama; model col null-ish — NOT guessed |
| anthropic | unknown | `unknown` | no model string |

---

## FIX CYCLE 1 (2026-07-05) — closed the family-disjointness bypass (XC red-team)

### The break (verified by XC)
`resolveFamily()` claimed "registry-only" but **fell back to `familyOf()`** for any model not in the
seed. `familyOf()` (`src/hal/fact-check.ts:63-75`) is a **first-match substring regex** that tests
`/deepseek/` before `/llama/`. So a Llama model aliased `deepseek-llama-3.3-70b` resolved to
`deepseek`, and a Llama judge would **pass** `checkDisjoint` against a Llama candidate — self-grading.

- **Repro:** candidate `llama-3.1-8b-instant` (llama) vs judge `deepseek-llama-3.3-70b` →
  old behavior returned `disjoint = true` (WRONG; the judge is really Llama).

### The fix (two parts, RULE-3 — root cause only)
1. **Runtime registry-only** — `src/decisioning/family-registry.ts:resolveFamily()`
   (now ~L133-141). Removed the `familyOf()` regex fallback at lookup time. A model absent from the
   explicit seed (`BY_MODEL`) now throws `UnmappedFamilyError` (register-first). The existing
   fail-closed-on-unknown/junk path is unchanged (XC confirmed it correct). `familyOf()` is now
   invoked **only** to populate a human-readable diagnostic in the thrown error — it does not steer
   the resolve decision (registry membership alone decides).
2. **Seed-integrity ambiguity detection** — same file, new helpers
   `matchedFamilies()` / `isAmbiguousFamily()` / `seedFamilyFor()` (~L82-125). At seed-build time, a
   model name carrying tokens for **more than one** known family (e.g. both `deepseek` and `llama`)
   is flagged **AMBIGUOUS** and routed to the "register explicitly" (unmapped) path — never
   first-matched. `seedFamilyFor()` is the only sanctioned way to derive a seed family from
   `familyOf()`; it refuses ambiguous names. So `deepseek-llama-*` and `llama-deepseek-*` can never be
   silently mis-seeded.

### Repro now blocked (verified)
- `resolveFamily('deepseek-llama-3.3-70b')` → **throws `UnmappedFamilyError`** (was silently `deepseek`).
  `checkDisjoint([llama-3.1-8b-instant], [deepseek-llama-3.3-70b])` therefore **throws** rather than
  returning `disjoint = true`. ✅ (repro result: NOT `disjoint=true`).
- `resolveFamily('llama-deepseek-chat')` → **throws `UnmappedFamilyError`** (mirror alias handled the same). ✅
- `isAmbiguousFamily('deepseek-llama-3.3-70b')` and `('llama-deepseek-chat')` → **true**;
  `seedFamilyFor(...)` → `{ seed: false, reason: AMBIGUOUS ... }` for both. ✅

### No regression on the real 21
- New test asserts **all 21 seeded models still resolve to their recorded family** (`FAMILY_REGISTRY_SEED`
  iterated; every `resolveFamily(model) === family`). ✅
- Existing self-tests (same-family reject, disjoint accept, sink fires, throwOnViolation, seeded
  rotation) all still pass.

### Verification
- Regression tests added to `tests/decisioning-disjointness.test.ts` (XC's exact repro + mirror alias +
  ambiguity + no-regression-on-21).
- `npx jest --config jest.config.js tests/decisioning-disjointness.test.ts` → **14 passed / 14**.
- `tests/hal-family-quorum.test.ts` → **5 passed** (HAL lane untouched, see follow-up below).
- `npx tsc --noEmit` → **exit 0**.

### Files changed
- `src/decisioning/family-registry.ts` — registry-only `resolveFamily()` + ambiguity helpers.
- `tests/decisioning-disjointness.test.ts` — FIX CYCLE 1 regression tests.
- `phase1-findings.md` — this section.

---

## FOLLOW-UP (out of scope here — separate HAL lane) — record only
The same `familyOf()` first-match regex (`src/hal/fact-check.ts:63-75`) **also gates HAL's live quorum
family-independence** (`familyOf` is used directly to count distinct families in the HAL quorum path).
HAL's family-independence check therefore **likely shares this exact bypass**: an aliased
`deepseek-llama-*` model would collapse two independent Llama votes into one mislabeled `deepseek`
vote, or let two same-family hosts count as independent. HAL should adopt the registry approach
(`resolveFamily`) rather than raw `familyOf()`. This is a **separate HAL-lane follow-up**, not fixed in
this Phase-1 decisioning scope.
