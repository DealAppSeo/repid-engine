# HAL v2 Tiered Consensus — Benchmark Results

**Mode:** MOCK
**Generated:** 2026-04-25T17:12:18.764Z
**Prompts:** 40
**Overall accuracy (verdict matches expected):** 82.5%

## Accuracy by category

| Category | Correct | Total | Accuracy |
|---|---|---|---|
| truth | 10 | 10 | 100.0% |
| hallucination | 10 | 10 | 100.0% |
| opinion | 10 | 10 | 100.0% |
| reasoning | 3 | 10 | 30.0% |

## Tier reached distribution

| Tier | Count |
|---|---|
| OUT_OF_SCOPE (no LLM call) | 10 |
| Tier 1 | 22 |
| Tier 2 | 8 |
| Tier 3 | 0 |

## Cost / latency

- Avg cost per check: $1.001e-4
- Avg latency per check: 0.3 ms

## Per-prompt detail

| id | category | classifier | tier | verdict | match |
|---|---|---|---|---|---|
| t1 | truth | geographic | 1 | TRUTH_VERIFIED | ✓ |
| t2 | truth | geographic | 1 | TRUTH_VERIFIED | ✓ |
| t3 | truth | scientific | 1 | TRUTH_VERIFIED | ✓ |
| t4 | truth | unclassified | 1 | TRUTH_VERIFIED | ✓ |
| t5 | truth | mathematical | 1 | TRUTH_VERIFIED | ✓ |
| t6 | truth | unclassified | 1 | TRUTH_VERIFIED | ✓ |
| t7 | truth | unclassified | 1 | TRUTH_VERIFIED | ✓ |
| t8 | truth | geographic | 1 | TRUTH_VERIFIED | ✓ |
| t9 | truth | geographic | 1 | TRUTH_VERIFIED | ✓ |
| t10 | truth | scientific | 1 | TRUTH_VERIFIED | ✓ |
| h1 | hallucination | geographic | 1 | HALLUCINATION_DETECTED | ✓ |
| h2 | hallucination | geographic | 1 | HALLUCINATION_DETECTED | ✓ |
| h3 | hallucination | unclassified | 1 | HALLUCINATION_DETECTED | ✓ |
| h4 | hallucination | scientific | 1 | HALLUCINATION_DETECTED | ✓ |
| h5 | hallucination | unclassified | 1 | HALLUCINATION_DETECTED | ✓ |
| h6 | hallucination | mathematical | 1 | HALLUCINATION_DETECTED | ✓ |
| h7 | hallucination | unclassified | 1 | HALLUCINATION_DETECTED | ✓ |
| h8 | hallucination | historical | 1 | HALLUCINATION_DETECTED | ✓ |
| h9 | hallucination | unclassified | 1 | HALLUCINATION_DETECTED | ✓ |
| h10 | hallucination | unclassified | 1 | HALLUCINATION_DETECTED | ✓ |
| o1 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o2 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o3 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o4 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o5 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o6 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o7 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o8 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o9 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| o10 | opinion | opinion | 0 | OUT_OF_SCOPE | ✓ |
| r1 | reasoning | mathematical | 2 | UNRESOLVED | ✗ |
| r2 | reasoning | unclassified | 1 | TRUTH_VERIFIED | ✓ |
| r3 | reasoning | unclassified | 2 | UNRESOLVED | ✗ |
| r4 | reasoning | mathematical | 2 | TRUTH_VERIFIED | ✓ |
| r5 | reasoning | geographic | 1 | TRUTH_VERIFIED | ✓ |
| r6 | reasoning | unclassified | 2 | UNRESOLVED | ✗ |
| r7 | reasoning | temporal | 2 | UNRESOLVED | ✗ |
| r8 | reasoning | unclassified | 2 | UNRESOLVED | ✗ |
| r9 | reasoning | mathematical | 2 | UNRESOLVED | ✗ |
| r10 | reasoning | unclassified | 2 | UNRESOLVED | ✗ |

---

### MOCK MODE caveat

This run used the deterministic mock provider in `hal-providers.ts`. No real LLM calls were made. The mock is fixture-aware for the 40 benchmark prompts: it pattern-matches obvious truths and obvious falsehoods so the orchestrator's consensus / escalation logic can be exercised end-to-end without API keys. **Mock accuracy is therefore an upper bound; real-provider accuracy depends on the actual SLM/frontier models.**

To run against real providers, set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` (and optionally `CEREBRAS_API_KEY` / `FIREWORKS_API_KEY`), then `HAL_V2_MOCK=0 npx jest --config jest.config.js tests/hal-tiered-consensus.test.ts --runInBand`.