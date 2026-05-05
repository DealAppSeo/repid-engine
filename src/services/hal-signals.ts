// @ts-nocheck
/**
 * HAL 5-Signal Independent Feature Extractor (legacy entry point).
 *
 * As of 2026-05-04 the actual implementation lives in `src/hal/lib/extract.ts`.
 * This file is preserved for backward compatibility — production callers in
 * src/routes/agents-external.ts and src/routes/v1.ts import
 * `extractHALSignals` from here, and the migration to lib-imports happens
 * in a follow-up sprint (CLAUDE-RULE-3 — fix only what's named).
 *
 * The async `extractHALSignalsWithCrossLLM` still composes Layer 0 (classifier)
 * and Layer 1 (cross-LLM) here; those modules are extracted to lib in Phase 4
 * of this sprint. After Phase 5, this entire file collapses into a re-export
 * shim.
 *
 * HyperDAG Protocol — ethical trust layer for the agentic economy.
 * Open standard. Contributions welcome: github.com/DealAppSeo/hyperdag-core
 *
 * Mathematical foundation: Pythagorean Comma Dissonance Detection
 * Reference: hyperdag-core/METHODOLOGY.md
 */

import {
  extractHALSignals as libExtractHALSignals,
} from '../hal/lib/extract';
import type {
  HALSignals as LibHALSignals,
} from '../hal/lib/types';

// Backward-compat re-export of the canonical type. The lib version is
// authoritative; this alias keeps existing import sites unchanged.
export type HALSignals = LibHALSignals;

/**
 * Sync 5-signal extractor. Pure, deterministic.
 *
 * Signature kept stable: (claimText, domain, certainty) — production callers
 * (`src/routes/agents-external.ts:184`, `src/routes/v1.ts:35`) and the
 * regression test (`tests/hal-regression.test.ts`) all use this 3-arg form.
 */
export function extractHALSignals(
  claimText: string,
  domain: string,
  certainty: number,
): HALSignals {
  return libExtractHALSignals({ text: claimText, domain, certainty });
}

/**
 * Validation: a 4-case sanity demo. Prints to stdout. Non-test code; left
 * in place for repl-style poking. The Phase 1 regression test (61 cases)
 * supersedes this for actual coverage.
 */
export function runValidation() {
  const cases = [
    {
      name: 'HIGH RISK — overconfident false CRE claim',
      text: 'LA industrial cap rates definitely compressed 4.8% in 2024, proven fact.',
      domain: 'cre-underwriting',
      certainty: 0.95,
    },
    {
      name: 'LOW RISK — appropriately hedged CRE claim',
      text: 'Based on CBRE data, industrial cap rates in LA may have compressed approximately 0.5-1.2% in Q3 2024.',
      domain: 'cre-underwriting',
      certainty: 0.82,
    },
    {
      name: 'HIGH RISK — false technical claim, no hedges',
      text: 'Plonky3 definitely uses BN254 elliptic curve with Groth16, absolutely requires trusted setup.',
      domain: 'technical',
      certainty: 0.92,
    },
    {
      name: 'LOW RISK — verifiable mathematical truth',
      text: 'The Pythagorean Comma ratio is exactly 531441/524288, approximately 1.01364, representing the gap between twelve perfect fifths and seven octaves.',
      domain: 'technical',
      certainty: 0.99,
    },
  ];

  console.log('=== HAL 5-SIGNAL VALIDATION ===\n');
  cases.forEach(c => {
    const signals = extractHALSignals(c.text, c.domain, c.certainty);
    const halScore = (
      0.4 * signals.harm_probability +
      0.3 * signals.epistemic_uncertainty +
      0.2 * (1 - signals.evidence_quality) +
      0.1 * (1 - signals.scope_appropriateness)
    ) * (531441 / 524288);
    console.log(`${c.name}`);
    console.log(`  harm=${signals.harm_probability.toFixed(3)} epistemic=${signals.epistemic_uncertainty.toFixed(3)} evidence=${signals.evidence_quality.toFixed(3)} scope=${signals.scope_appropriateness.toFixed(3)}`);
    console.log(`  HAL score: ${halScore.toFixed(4)} | Vetoed: ${halScore >= 0.25}\n`);
  });
}

/**
 * Phase 1.5 — async extension that wraps the sync 5-signal extractor with
 * Layer 0 (prompt classifier) + Layer 1 (cross-LLM agreement).
 *
 * Behavior:
 *   - If `prompt` is missing → returns the 5-signal result unchanged
 *     (agreement_score null, prompt_category null).
 *   - Otherwise: classify(prompt). If category in {factual, time-sensitive},
 *     also run cross-LLM checkCrossLLM(prompt) in parallel with the sync
 *     extraction. Set agreement_score on the returned signals.
 *   - On classifier or cross-LLM failure: fall back to 5-signal mode.
 *
 * This composer remains in services/ for now; Phase 4 extracts the
 * classifier + cross-llm modules into the lib, and Phase 5 introduces
 * `lib/hal/evaluate.evaluate(claimText, output, ctx)` as the canonical
 * top-level entry point.
 */
export async function extractHALSignalsWithCrossLLM(
  claimText: string,
  domain: string,
  certainty: number,
  prompt?: string,
): Promise<HALSignals> {
  const baseSignals = extractHALSignals(claimText, domain, certainty);
  if (!prompt || !prompt.trim()) {
    return { ...baseSignals, agreement_score: null, prompt_category: null };
  }
  const { classify } = require('../hal/classifier');
  const { checkCrossLLM } = require('../hal/cross-llm-client');
  let category: string | null = null;
  let agreement: number | null = null;
  let comma_veto: boolean | null = null;
  let comma_gap: number | null = null;
  let comma_severity: 'none' | 'minor' | 'major' | 'critical' | null = null;
  try {
    const cls = await classify(prompt);
    category = cls?.category ?? null;
    if (category === 'factual' || category === 'time-sensitive' || category === 'math') {
      // P5-A (2026-05-04): 'math' added so Pythagorean Comma BFT can fire on
      // math fabrications (HAL-T1-003: 256/243 ≠ Pythagorean Comma). Without
      // this, the *0.15 mathematics dampening lands hal_score below 0.25 and
      // there's no Layer 1 path to catch the mis-stated foundational ratio.
      const cmp = await checkCrossLLM(prompt);
      if (cmp && typeof cmp.agreement_score === 'number') {
        agreement = cmp.agreement_score;
        comma_veto = typeof cmp.comma_veto === 'boolean' ? cmp.comma_veto : null;
        comma_gap = typeof cmp.comma_gap === 'number' ? cmp.comma_gap : null;
        comma_severity = cmp.comma_severity ?? null;
      }
    }
  } catch (e: any) {
    console.error('[hal-signals] cross-LLM extension failed:', e?.message ?? e);
  }
  return {
    ...baseSignals,
    agreement_score: agreement,
    prompt_category: category,
    comma_veto,
    comma_gap,
    comma_severity,
  };
}

if (require.main === module) { runValidation(); }
