# HAL Inventory — pre-extraction surface map

**Sprint:** `feat/hal-extraction-library-2026-05-04` (CC1, 2026-05-05).
**Companion canonical reference:** `docs/HAL_CANONICAL_v1.md` (commit-pinned to `36226dc`).
**Why this exists:** the 2026-05-04 HAL-extraction sprint was originally written assuming HAL lived in `trinity-symphony-shared/lib/ConstitutionalAgentV4.js`. Empirical search proved HAL is in `repid-engine`. This file captures the actual surface area in the actual repo.

All file:line citations refer to `feat/hal-extraction-library-2026-05-04` HEAD `204cfcb` (HAL files identical to `main` HEAD `d8915e43`).

---

## 1. Files containing HAL logic

| File | Lines | Purpose | Status |
|---|---|---|---|
| `src/services/hal-signals.ts` | 252 | Public HAL extractors. `extractHALSignals` (sync, 5 signals) + `extractHALSignalsWithCrossLLM` (async, adds Layer 0 classifier + Layer 1 cross-LLM agreement + Comma BFT) | live; called from production |
| `src/hal/cross-llm-client.ts` | 537 | Layer 1 cross-LLM consensus + Pythagorean Comma BFT veto check (P-003). 3 providers (groq + anthropic + deepseek), embedding-cosine agreement w/ jaccard fallback | live; called by `extractHALSignalsWithCrossLLM` |
| `src/hal/classifier.ts` | 218 | Layer 0 prompt classifier — factual / time-sensitive / opinion / etc. Decides whether cross-LLM check fires | live; called by `extractHALSignalsWithCrossLLM` |
| `src/services/anfis-comma.ts` | 132 | 5-input/5-rule Gaussian ANFIS forward pass with golden-ratio centers. Exports `commaANFIS` | **DEAD CODE** — no callers in repo (per canonical doc, confirmed by grep) |
| `src/services/hal-tester.ts` | 143 | Benchmark harness against `hal_test_prompts` Supabase table | benchmark / antifragility — out of MVP path |
| `docs/HAL_CANONICAL_v1.md` | 241 | Authoritative spec mapping every formula to file:line | reference |

Total: ~1523 lines incl. docs; ~1006 lines of live HAL JS/TS; ~132 lines of dead code.

---

## 2. Public API surface (what gets called from outside)

### `src/services/hal-signals.ts`

```typescript
export interface HALSignals {
  harm_probability: number;       // [0,1]
  epistemic_uncertainty: number;  // [0,1]
  evidence_quality: number;       // [0,1]  ("how good" — caller inverts to risk)
  scope_appropriateness: number;  // [0,1]  ("how good" — caller inverts to risk)
  certainty_at_claim: number;     // [0,1]  pass-through
  agreement_score?: number | null;       // Layer 1 — null if not factual/time-sensitive
  prompt_category?: string | null;       // Layer 0 — classifier output
  comma_veto?: boolean | null;           // Pythagorean Comma BFT — true iff severity='critical'
  comma_gap?: number | null;             // max(beliefs) - min(beliefs); null if <3 providers
  comma_severity?: 'none' | 'minor' | 'major' | 'critical' | null;
}

export function extractHALSignals(
  claimText: string, domain: string, certainty: number
): HALSignals;

export async function extractHALSignalsWithCrossLLM(
  claimText: string, domain: string, certainty: number, prompt?: string
): Promise<HALSignals>;

export function runValidation(): void;  // 4-case sanity demo, prints to stdout
```

### `src/hal/cross-llm-client.ts`

```typescript
export type Squad = 'alpha' | 'beta' | 'gamma';
export type CommaSeverity = 'none' | 'minor' | 'major' | 'critical';
export interface ProviderAnswer { ... }
export interface CrossLLMResult { ... }
export async function checkCrossLLM(prompt: string): Promise<CrossLLMResult>;
export { PYTHAGOREAN_COMMA_RATIO };  // = 531441/524288 ≈ 1.0136433
```

### `src/hal/classifier.ts`

```typescript
export type Category = 'factual' | 'time-sensitive' | 'opinion' | 'creative' | 'task' | 'other';
export type Confidence = 'high' | 'medium' | 'low';
export interface ClassificationResult { ... }
export interface ClassifyOptions { ... }
export async function classify(prompt: string, opts?: ClassifyOptions): Promise<ClassificationResult>;
```

### `src/services/anfis-comma.ts` (dead code, kept for reference)

```typescript
export function commaANFIS(inputs: number[]): { ... };
export function testCommaANFIS(): void;
```

---

## 3. Production call sites (where HAL is actually invoked)

Two and only two places in `src/routes/`:

### Path A — `POST /api/v1/hal/signals` (signal-extraction-only endpoint)

`src/routes/v1.ts:32-35`:

```typescript
const { extractHALSignals, extractHALSignalsWithCrossLLM } = require('../services/hal-signals');
const signals = prompt
  ? await extractHALSignalsWithCrossLLM(text, domain || 'finance', certainty || 0.85, prompt)
  : extractHALSignals(text, domain || 'finance', certainty || 0.85);
```

Computes a `hal_score` (line 25) using the 5-signal canonical formula:
```
hal_score = (0.4·harm + 0.3·epistemic + 0.2·(1−evidence) + 0.1·(1−scope)) × (531441/524288)
```

### Path B — `POST /api/v1/agents/:id/score-event` (production scoring, the live path)

`src/routes/agents-external.ts:5,179-196`:

```typescript
import { extractHALSignals, extractHALSignalsWithCrossLLM } from '../services/hal-signals';
// ...
const halSignals = prompt
  ? await extractHALSignalsWithCrossLLM(decision_text, task_domain || 'finance', certainty || 0.85, prompt)
  : extractHALSignals(decision_text, task_domain || 'finance', certainty || 0.85);
// Output stored in metadata.hal_signals BUT NOT USED FOR VETO DECISION (per canonical doc).
// Veto path uses inline certainty-only piecewise (lines 186-196), not the extractor output.
```

**Critical canonical-doc observation:** Path B currently *invokes* `extractHALSignals` but its veto decision uses an **inline certainty-only piecewise extractor** (`agents-external.ts:186-196`), not the extractor's output. The 5-signal extractor output is logged to `metadata.hal_signals` but doesn't influence the verdict.

This is a known divergence — see canonical doc section "Two coexisting HAL paths exist." Out of scope to unify in this sprint (CLAUDE-RULE-3); document and parking-lot.

---

## 4. External dependencies

### LLM SDKs / direct HTTP

`src/hal/cross-llm-client.ts` does not use any official SDK. Direct `fetch` calls to:
- `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compat)
- `https://api.anthropic.com/v1/messages` (Anthropic native)
- `https://api.deepseek.com/v1/chat/completions` (OpenAI-compat)
- `https://api.openai.com/v1/embeddings` (for similarity)

API keys read via `process.env.GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`. **Library extraction will need to inject these via parameters, not env reads.**

`src/hal/classifier.ts` — uses Groq directly (`callGroq` at `:72`). Same env-var pattern.

### Supabase

- `src/hal/cross-llm-client.ts:36,375` — imports `db` from `../db` and persists results to `cross_llm_comparisons` table (function `persist` at `:375`)
- `src/hal/classifier.ts:138` — persists classification to (table TBD, will read in Phase 1)
- `src/services/hal-signals.ts` — does not write Supabase directly

`db` is a singleton Supabase client from `src/db.ts`. **Library will need a `supabase` parameter (nullable — null disables logging).**

### Env vars (full list)

Read directly inside HAL modules (must become DI params for library):
- `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` (LLM auth)
- `CROSS_LLM_PROVIDER_1_MODEL`, `CROSS_LLM_PROVIDER_1_ENDPOINT`
- `CROSS_LLM_PROVIDER_2_MODEL`, `CROSS_LLM_PROVIDER_2_ENDPOINT`
- `CROSS_LLM_PROVIDER_3_MODEL`, `CROSS_LLM_PROVIDER_3_ENDPOINT`
- `CROSS_LLM_VERIFIER_URL` (optional HTTP proxy mode — routes through trinity-ecosystem's canonical module)

### Inline constants (5 places where `531441/524288` or its decimal appears)

| File:line | Form | Notes |
|---|---|---|
| `src/services/hal-signals.ts:191` | `(531441 / 524288)` | inside `runValidation` demo |
| `src/hal/cross-llm-client.ts:64` | `const PYTHAGOREAN_COMMA_RATIO = 531441 / 524288` | exported (line 537) |
| `src/services/anfis-comma.ts:15` | `const COMMA_RATIO = 531441 / 524288` | dead-code module |
| `src/routes/agents-external.ts:9` | `const PYTHAGOREAN_COMMA = 531441 / 524288` | (per canonical doc) |
| `src/routes/v1.ts:25` | inline `(531441 / 524288)` | (per canonical doc) |

**Sprint hard rule #15:** preserve exact ratio form. Library will define this once in `src/hal/lib/constants.ts`; consumers import.

---

## 5. The 5-signal block (patent-load-bearing — preserved exactly)

Per `hal-signals.ts:59-77` and canonical doc:

| Signal | Field name | Range | Encodes |
|---|---|---|---|
| 1 | `harm_probability` | [0,1] | risk of downstream harm (high = bad) |
| 2 | `epistemic_uncertainty` | [0,1] | confidence-hedging mismatch (high = bad) |
| 3 | `evidence_quality` | [0,1] | specificity / verifiability (high = good) |
| 4 | `scope_appropriateness` | [0,1] | domain ontology overlap (high = good) |
| 5 | `certainty_at_claim` | [0,1] | self-reported (pass-through) |

The sprint file references "6-DOF" with `agreement_score` as the 6th. Reality: `agreement_score` is **derived from cross-LLM consensus** (Layer 1 output), not an independent signal extracted from the claim text. Treating it as the "6th DOF" is a slight misnomer but functionally harmless — the library will expose it as a separate optional field on the `HALSignals` interface (matching current code), not as one of the 5 base signals.

---

## 6. The dissonance / hal_score formula (preserved exactly)

Path A formula (canonical, used in `/api/v1/hal/signals`):

```
hal_score =
  (0.4·harm_probability
 + 0.3·epistemic_uncertainty
 + 0.2·(1 − evidence_quality)
 + 0.1·(1 − scope_appropriateness))
  × (531441/524288)
```

The `(1 − x)` inversions on evidence_quality and scope_appropriateness convert "quality" to "risk" before combining.

Veto decision: `vetoed = hal_score >= 0.25` (per `hal-signals.ts:194` in the demo runValidation; the live verdict thresholds in `/score-event` use 0.25 / 0.48 / config-driven per canonical doc section "Verdict thresholds").

---

## 7. Risks and tight couplings (extraction concerns)

1. **`extractHALSignalsWithCrossLLM` uses `require()` at runtime line 220-221**, not top-of-file imports. This was probably to avoid circular import issues. Library extraction needs to preserve lazy loading OR resolve the cycle.
2. **`src/db.ts` is a singleton.** `cross-llm-client.ts` imports it directly. Library must inject Supabase rather than import `../db`.
3. **`@ts-nocheck` at top of `hal-signals.ts`** — type checking is disabled. Library version should re-enable strict types as part of clean extraction (or at least audit).
4. **Provider configs hardcoded with env-var reads at `cross-llm-client.ts:92-118`.** Library version: provider configs become explicit parameters.
5. **Dead `commaANFIS` module.** Out of scope to delete (CLAUDE-RULE-3); flag for parking lot.
6. **Inline Path B in `agents-external.ts`** is not a function call — it's inline piecewise math on `certainty`. It's an alternate HAL implementation that happens to share the Pythagorean Comma constant but otherwise uses a different feature extraction. Out of scope to unify.
7. **Tests for HAL exist?** Need to grep — preliminary check shows no `hal-signals.test.ts` in `tests/`. Phase 1 will be the first regression net.

---

## 8. Proposed library shape (Phase 2 design preview)

```
src/hal/lib/
├── index.ts          // public API exports
├── constants.ts      // PYTHAGOREAN_COMMA, OVERCONFIDENCE_MARKERS, EPISTEMIC_HEDGES, DOMAIN_ONTOLOGIES
├── types.ts          // HALSignals, HALContext, HALProviderConfig, CommaSeverity, etc.
├── extract.ts        // extractHALSignals (sync, 5 signals) — pure function, no I/O
├── score.ts          // computeHALScore(signals, threshold?) — pure
├── cross-llm/
│   ├── index.ts      // checkCrossLLM(prompt, providers, options) — DI clients
│   ├── providers.ts  // openai-compat + anthropic-native callers (parameterized)
│   ├── similarity.ts // cosine + jaccard (pure)
│   └── bft.ts        // checkPythagoreanComma (pure, ports the BFT logic)
├── classifier.ts     // classify(prompt, providers, options) — DI clients
├── evaluate.ts       // evaluate(prompt, output, ctx) — top-level composed entry point
└── package.json      // (Phase 6) @hyperdag/hal v0.1.0-alpha
```

**Public API for external callers (Gemini benchmarks, @hyperdag/protocol kernel):**

```typescript
import { evaluate, HAL_PYTHAGOREAN_COMMA } from 'src/hal/lib';
const result = await evaluate(prompt, output, {
  domain: 'finance',
  certainty: 0.85,
  providers: { groq: groqClient, anthropic: anthropicClient, deepseek: dsClient },
  embeddingClient: openaiClient,
  supabase: null,  // null = no logging
  threshold: undefined,  // undefined = default 0.25
});
// result: { signals: HALSignals, hal_score, vetoed, comma_severity, ... }
```

Production code in `src/routes/agents-external.ts` and `src/routes/v1.ts` becomes:

```typescript
import { evaluate } from '../hal/lib';
// providers built once at module init from env vars
const result = await evaluate(text, output, { ...productionContext });
```

---

## 9. Files NOT to be touched in this sprint

Per CLAUDE-RULE-3 (code discipline) + sprint hard rule #5 (production safety):

- `src/services/anfis-comma.ts` — dead code, but deleting is out of scope (parking lot).
- `src/routes/agents-external.ts` Path B inline piecewise (lines 186-196) — unify with Path A is out of scope (parking lot).
- `src/services/hal-tester.ts` — benchmark harness, not on production path; touched only if Phase 5 smoke test reveals it as the right consumer.
- Anything outside `src/services/hal-signals.ts`, `src/hal/`, `src/routes/agents-external.ts:179-184`, `src/routes/v1.ts:32-35`, except the new `src/hal/lib/` directory.

---

## 10. Plan adjustment from sprint file

| Sprint phase | Adapted for repid-engine |
|---|---|
| Phase 1 — Regression test foundation | Hand-craft 50-100 cases for `extractHALSignals` (sync, deterministic). Async cross-LLM/classifier paths get unit tests in Phase 4 with mocked LLMs. |
| Phase 2 — Library API design | `lib/hal/` → `src/hal/lib/` (matches repo's `src/` convention) |
| Phase 3 — Extract evaluation core | Move `extractHALSignals` + constants + dissonance scoring to `src/hal/lib/`. Update `src/services/hal-signals.ts` to re-export from lib for backward compat (production callers don't need to change paths). |
| Phase 4 — Cross-LLM consensus extraction | `src/hal/cross-llm-client.ts` → `src/hal/lib/cross-llm/`. Refactor to DI providers. |
| Phase 5 — External-caller smoke | Path: `examples/hal-external-caller.ts` (not under `src/`, per sprint file) |
| Phase 6 — npm package prep | Optional, only if 1-5 land cleanly |
| Phase 7 — Full regression | Re-run Phase 1 + smoke production routes |

---

## 11. Trinity Supabase HAL evaluation logs

Sprint Phase 1 task #1 mentions querying "agent_logs (or whatever table HAL writes evaluation records to)" for production case examples. **Need to locate the table.** Candidates from prior sessions: `hal_production_events`, `cross_llm_comparisons` (used by HAL's persist), `trinity_truth_log`. Will check schema in Phase 1.


---

## Wave 5 update (2026-05-04)

The library structure has grown beyond the original Phase 3 inventory. Files added by Wave 5 sprint:

| File | Purpose |
|---|---|
| `src/hal/lib/semantic.ts` | `semanticPairSimilarity`, `computeSemanticSimilarity` — pair/set cosine on embeddings, Jaccard fallback |
| `src/hal/lib/claim-comparison.ts` | `compareConsensusToClaim` — picks consensus answer, compares against user claim, returns contradicts boolean |
| `src/hal/lib/zones.ts` | `classifyAgreementZone` — three-zone Pythagorean Comma band (too-tight/in-band/too-loose) |
| `src/hal/lib/cross-llm/embedding-client.ts` | `XenovaEmbeddingClient`, `OpenAIEmbeddingClient`, `VoyageEmbeddingClient`, `FallbackEmbeddingClient`, `createDefaultEmbeddingClient` — embedding-backend factories |
| `src/hal/lib/clients/embedding.ts` | Alternative factory functions (xenova-local, openai) — both shapes coexist |
| `docs/HAL_TAMPERING_DETECTION.md` | Spec for level-5 tampering signal |

Files modified by Wave 5:

| File | Change |
|---|---|
| `src/hal/lib/types.ts` | Added `StrictnessLevel`, `AgreementZone`, `HALTamperingSignal` types; `HALResult` extended with `agreement_zone`, `consensus_answer`, `claim_vs_consensus_similarity`, `claim_contradicts_consensus`, `tampering_suspected`, `tampering_signal`, `strictness`; `HALContext` accepts optional `strictness` (default 4) |
| `src/hal/lib/constants.ts` | Added `COMMA_BAND_TIGHT_THRESHOLD = 0.99`, `COMMA_BAND_LOOSE_THRESHOLD = 0.95` |
| `src/hal/lib/evaluate.ts` | Added strictness routing: L1 skips cross-LLM, L4+ runs zone classification + claim-vs-consensus, L5 sets tampering flag |

The Pythagorean Comma constant remains `531441/524288` — never modified (hard-rule #2).
