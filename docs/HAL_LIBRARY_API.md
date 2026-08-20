# HAL Library API (v0.1.0-alpha)

**Module path (in-repo):** `src/hal/lib/`
**Future npm name:** `@hyperdag/hal` (Phase 6 of the 2026-05-04 extraction sprint; not yet published)
**License:** Apache-2.0
**Status:** **alpha** — interfaces stable since 2026-05-04, implementation lands progressively across Phases 3–5 of the extraction sprint.

## Why this exists

HAL (Hallucination Auditor Layer) is the load-bearing pre-mint check for the HyperDAG receipt-bridge: it converts a (prompt, output) pair into a 5-signal "epistemic risk" vector and a single `hal_score`, with optional cross-LLM consensus + Pythagorean Comma BFT veto. It currently lives entwined with `repid-engine`'s express routes and Supabase clients. This library extracts it cleanly so:

- `hyperdag-bench` can run real-HAL benchmarks for internal benchmarking (P-001/P-002/P-003)
- `@hyperdag/protocol` can wire HAL as the default `hallucinationDetector` implementation in its modular-kernel design
- Third-party consumers (e.g. Gemini's evaluation harness) consume HAL without dragging in Trinity Supabase, the agent runtime, or env-var coupling

## Public surface (re-exported via `src/hal/lib/index.ts`)

```typescript
import {
  // Constants — load-bearing, see constants.ts comments
  HAL_PYTHAGOREAN_COMMA,            // = 531441 / 524288
  HAL_FORMULA_WEIGHTS,              // canonical 0.4/0.3/0.2/0.1 weights
  HAL_DEFAULT_VETO_THRESHOLD,       // 0.25
  HAL_CONSTITUTIONAL_BLOCK_THRESHOLD, // 0.48 (used by /score-event consumers)
  COMMA_BFT_THRESHOLDS,             // P-003 severity tier thresholds
  DEFAULT_DOMAIN_ONTOLOGIES,        // 5 baked-in ontologies
  OVERCONFIDENCE_MARKERS,
  EPISTEMIC_HEDGES,

  // Types
  HALSignals, HALResult, HALContext, HALProviderConfig, HALEmbeddingClient,
  CommaSeverity, CrossLLMSummary, ExtractInput,

  // Pure functions (real)
  computeHALScore,                  // canonical hal_score formula

  // Stubs landing in subsequent phases
  extractHALSignals,                // Phase 3
  classify,                         // Phase 4
  checkCrossLLM,                    // Phase 4
  evaluate,                         // Phase 5 — top-level entry
} from 'src/hal/lib';
```

## Top-level API: `evaluate(claimText, output, context)` (Phase 5 land)

```typescript
const result = await evaluate(claimText, output, {
  domain: 'cre-underwriting',           // required — selects ontology
  certainty: 0.85,                      // required — caller-supplied [0,1]
  prompt: 'What is the going-in cap rate?', // optional — enables Layer 0/1
  providers: [                          // optional — empty disables cross-LLM
    { provider: 'groq', squad: 'alpha', model: 'llama-3.3-70b-versatile',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY, callType: 'openai-compat' },
    { provider: 'anthropic', squad: 'beta', model: 'claude-haiku-4-5-20251001',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: process.env.ANTHROPIC_API_KEY, callType: 'anthropic-native' },
    { provider: 'deepseek', squad: 'gamma', model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY, callType: 'openai-compat' },
  ],
  embeddingClient: {                    // optional — falls back to Jaccard
    endpoint: 'https://api.openai.com/v1/embeddings',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
  },
  supabase: null,                        // null/omit ⇒ no logging
  threshold: undefined,                  // undefined ⇒ HAL_DEFAULT_VETO_THRESHOLD (0.25)
  domainOntologies: undefined,           // optional extra ontologies
});

// result is HALResult:
//   {
//     signals: { harm_probability, epistemic_uncertainty, evidence_quality,
//                scope_appropriateness, certainty_at_claim,
//                agreement_score?, prompt_category?, comma_veto?, comma_gap?,
//                comma_severity? },
//     hal_score: number,
//     vetoed: boolean,
//     threshold: number,
//     formula: 'hal-canonical-v1',
//     cross_llm: CrossLLMSummary | null,
//   }
```

## Lower-level APIs (composable)

- `extractHALSignals({ text, domain, certainty, domainOntologies? }) → HALSignals` — sync, deterministic, no I/O
- `computeHALScore(signals, threshold?) → { hal_score, vetoed, threshold, formula }` — pure
- `classify(prompt, { provider, supabase?, timeoutMs? }) → ClassificationResult` — async, Layer 0
- `checkCrossLLM(prompt, { providers, embeddingClient?, supabase?, timeoutMs? }) → CrossLLMSummary` — async, Layer 1 + BFT

## Dependency injection rules

The library never reads `process.env` directly. Every external client is passed in:

| Side effect | DI parameter | Behavior when absent |
|---|---|---|
| Groq / Anthropic / DeepSeek inference | `context.providers[]` | cross-LLM consensus skipped; `cross_llm` returns `null` |
| OpenAI embeddings | `context.embeddingClient` | falls back to Jaccard token-set similarity |
| Supabase logging (`cross_llm_comparisons`, classifier persist) | `context.supabase` | library is silent; no DB writes |

This makes the library safe to import into pure-functional benchmark harnesses and into agent runtimes alike — both can call `evaluate()` and get the same result shape, only differing in the optional logging side effects.

## Disclosure caveats

- The Pythagorean Comma constant (`HAL_PYTHAGOREAN_COMMA = 531441/524288`) is a **configurable consensus threshold** — its exact ratio is disclosure-relevant for P-003. Library docs describe it abstractly; library code uses the ratio form (never the decimal approximation 1.0136433).
- The 5 signal field names (`harm_probability`, `epistemic_uncertainty`, `evidence_quality`, `scope_appropriateness`, `certainty_at_claim`) are load-bearing — never rename.
- Veto logic flow is preserved: `hal_score = (Σ wᵢ × signalᵢ) × HAL_PYTHAGOREAN_COMMA`, with `vetoed = hal_score ≥ threshold`. Comma BFT critical severity is OR'd into the final veto decision in `evaluate()`.

## Module layout

```
src/hal/lib/
├── index.ts             public exports (this list)
├── constants.ts         all magic numbers + ontologies + marker lists
├── types.ts             HALSignals, HALContext, HALResult, etc.
├── score.ts             computeHALScore (REAL — Phase 2)
├── extract.ts           extractHALSignals (STUB — Phase 3 lands real impl)
├── classifier.ts        classify (STUB — Phase 4)
├── cross-llm/
│   └── index.ts         checkCrossLLM (STUB — Phase 4)
└── evaluate.ts          top-level evaluate (STUB — Phase 5)
```

## Validated External Consumption

_Section to be filled in Phase 5 after `examples/hal-external-caller.ts` runs successfully against the production code with no `repid-engine` runtime coupling._

## Future: `@hyperdag/hal` npm package

_Section to be filled in Phase 6 after `npm pack --dry-run` succeeds._

## Versioning

- `0.1.0-alpha` — initial extraction.
- `0.2.0-alpha` — **Wave 5 (2026-05-04)**: strictness scale, semantic similarity, consensus-vs-claim comparison, three-zone Pythagorean Comma band, tampering detection at level 5. See "Strictness Scale" below.
- Breaking changes require: (a) coordinated update of all in-repo consumers, (b) update of any external consumers (Gemini, @hyperdag/protocol), (c) bump major version.
- New optional fields on `HALSignals` or `HALContext` may be added without a major bump as long as defaults preserve prior behavior.

---

## Strictness Scale (Wave 5)

```typescript
type StrictnessLevel = 1 | 2 | 3 | 4 | 5;

interface HALContext {
  // ... existing fields
  strictness?: StrictnessLevel;  // default: 4
}
```

| Level | Cross-LLM | Similarity | Threshold | Consensus-vs-Claim | Tampering | Use Case |
|---|---|---|---|---|---|---|
| **1 — Fast** | OFF | n/a | score-only | OFF | OFF | Brainstorming, drafts |
| **2 — Light** | ON | semantic (cosine) | loose | OFF | OFF | Internal docs, casual Q&A |
| **3 — Balanced** | ON | semantic (cosine) | comma BFT | OFF | OFF | Default-equivalent of pre-Wave-5 production |
| **4 — Strict (DEFAULT)** | ON | semantic (cosine) | comma BFT | ON | OFF | Customer-facing, professional |
| **5 — Maximum** | ON | semantic (cosine) | comma BFT | ON | ON | Legal, medical, financial, regulatory |

### Default reasoning

Default level is **4** (not 3) because the product MVP must catch what users would expect to be caught out of the box. HAL-T1-003 ("Pythagorean Comma equals 1.5 cents from 256/243") only vetoes when consensus-vs-claim comparison is wired (level 4+); defaulting to 4 means the headline use case works without explicit configuration.

Level 3 preserves byte-identical pre-Wave-5 production behavior (gap-based COMMA_BFT critical-veto, no zone classification, no claim comparison) and is the right pin when a caller needs strict back-compat with anything that existed before 2026-05-04.

### What runs at each level

```ts
import { evaluate } from '@hyperdag/hal'; // or src/hal/lib in-repo

// Level 1 — extract + score only
const r1 = await evaluate(claim, output, { domain, certainty, strictness: 1 });

// Level 2 — adds cross-LLM with semantic similarity
const r2 = await evaluate(claim, output, {
  domain, certainty, prompt, providers, embeddingClient,
  strictness: 2,
});

// Level 3 — adds Pythagorean Comma BFT critical-veto (current production behavior)
const r3 = await evaluate(claim, output, {
  domain, certainty, prompt, providers, embeddingClient,
  strictness: 3,
});

// Level 4 (DEFAULT) — adds three-zone band classification + claim-vs-consensus comparison
const r4 = await evaluate(claim, output, {
  domain, certainty, prompt, providers, embeddingClient,
  strictness: 4,                                 // or omit (default)
});

// Level 5 — adds tampering detection (informational flag only)
const r5 = await evaluate(claim, output, {
  domain, certainty, prompt, providers, embeddingClient,
  strictness: 5,
});
if (r5.tampering_suspected) {
  // Review responses, escalate, or apply policy.
  console.warn(r5.tampering_signal!.reason);
}
```

### Three-zone Pythagorean Comma band (level 4+)

```typescript
type AgreementZone = 'too-tight' | 'in-band' | 'too-loose';
```

The cross-LLM `agreement_score` (mean pairwise similarity) is classified relative to the Pythagorean Comma normalized value (`1 / 1.0136433 ≈ 0.987`):

- **`too-tight`** (`> 0.99`): suspiciously perfect agreement — at level 5, populates `tampering_signal`.
- **`in-band`** (`0.95 – 0.99`): trusted consensus — at level 4+, triggers the consensus-vs-claim comparison.
- **`too-loose`** (`≤ 0.95`): uncertainty — caller may treat as a low-confidence answer.

Boundaries (`COMMA_BAND_TIGHT_THRESHOLD = 0.99`, `COMMA_BAND_LOOSE_THRESHOLD = 0.95`) are calibratable. The Pythagorean Comma constant (`531441/524288`) is fixed and load-bearing.

### Consensus-vs-claim comparison (level 4+)

When the consensus zone is `in-band`, HAL picks a representative consensus answer (median-embedding when embeddings are available, longest-text fallback) and compares it against the user's claim text via cosine on embeddings (or Jaccard fallback). When `similarity < 0.4`, the claim is considered to contradict the consensus and `vetoed` is set to `true`.

```ts
const r = await evaluate(claim, output, {
  domain, certainty, prompt, providers, embeddingClient,
  strictness: 4,
});
console.log(r.agreement_zone);                    // 'too-tight' | 'in-band' | 'too-loose' | null
console.log(r.consensus_answer);                  // string | null (set only when zone='in-band')
console.log(r.claim_vs_consensus_similarity);     // number | null
console.log(r.claim_contradicts_consensus);       // boolean | null
```

### Tampering detection (level 5)

When the consensus zone is `too-tight` AND strictness is 5, HAL populates `tampering_suspected = true` and `tampering_signal`. The flag is **informational** in v0.2 — it does NOT auto-veto. See [HAL_TAMPERING_DETECTION.md](./HAL_TAMPERING_DETECTION.md) for the full spec, four-cause taxonomy, and inspection patterns.

### Federated-learning calibration (forward-looking)

The zone boundaries (0.95 / 0.99), claim-contradiction threshold (0.4), and strictness-level routing are initial values. The federated learning loop (v0.3+) refines them from production data while keeping the Pythagorean Comma constant fixed. Until then, callers can override:

- `context.threshold` — the `hal_score` veto threshold (default 0.25)
- `compareConsensusToClaim({ contradictionThreshold })` — the claim-vs-consensus contradiction threshold (default 0.4) — useful for ablation studies in benchmarks

### Updated module layout (Wave 5)

```
src/hal/lib/
├── index.ts                     public exports
├── constants.ts                 + COMMA_BAND_TIGHT_THRESHOLD/LOOSE_THRESHOLD
├── types.ts                     + StrictnessLevel, AgreementZone, HALTamperingSignal
├── score.ts                     computeHALScore (real)
├── extract.ts                   extractHALSignals (real)
├── classifier.ts                classify (real)
├── cross-llm/
│   ├── index.ts                 checkCrossLLM (real)
│   ├── agreement.ts             cosineSimilarity, jaccardSimilarity, BFT
│   ├── providers.ts             provider HTTP wrappers
│   └── embedding-client.ts      Xenova / OpenAI / Voyage / Fallback
├── clients/
│   └── embedding.ts             alternative factory (xenova-local, openai)
├── semantic.ts                  computeSemanticSimilarity, semanticPairSimilarity (Wave 5)
├── claim-comparison.ts          compareConsensusToClaim (Wave 5)
├── zones.ts                     classifyAgreementZone (Wave 5)
└── evaluate.ts                  top-level evaluate(claim, output, context)
```
