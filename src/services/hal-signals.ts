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
import { db } from '../db';

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
  /**
   * The agent whose memory should be recalled into the prompt.
   *
   * Optional so existing callers keep compiling, but its absence now means
   * "inject nothing" rather than "inject from three hardcoded ids". See the
   * Graph RAG block below for why that distinction is the entire fix.
   */
  agentId?: string,
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
  
  // Phase 3: Pre-LLM Graph RAG injection — recall the CALLING agent's memory.
  //
  // This block previously recalled from three hardcoded uuids
  // (550e8400-…-440000/1/2, the ALPHA/BETA/GAMMA_SQUAD_REP placeholders from
  // scripts/seed-squad-memories.ts). Measured against the live database on
  // 2026-08-13, those three ids own **zero** rows in agent_memory_nodes and do
  // not exist in repid_agents at all. graph_rag_match_nodes therefore returned
  // [] on every call, flatMemories was always empty, enrichedPrompt always
  // equalled prompt, and no error was ever raised — an empty result set is not
  // an error. Memory injection ran on every HAL turn and was a no-op by
  // construction, which is why access_count was 0 across all 429 memory nodes.
  //
  // The real spokesperson memories belong to four different agents
  // (trinity-sophia, -veritas, -shofet, -chesed). Recall is scoped per agent —
  // graph_rag_match_nodes filters `agent_id = p_agent_id` — so the only correct
  // id here is the agent actually being scored.
  //
  // When no agentId is supplied we now inject nothing and say so. Falling back
  // to a fixed id would reintroduce exactly the bug above, in a form that looks
  // like it is working.
  let enrichedPrompt = prompt;
  let memoryInjected = 0;
  if (!agentId) {
    console.info('[hal-signals] graph-rag: skipped, no agentId supplied by caller');
  } else {
    try {
      const { RetrievalService } = require('./graph-rag/retrieval-service');
      const retriever = new RetrievalService(db);

      const memories = await retriever.retrieve({
        query: prompt,
        agent_id: agentId,
        // 3, not 1: this queries one agent now rather than three, and a single
        // top hit is a thin basis for a claim-verification prompt.
        top_k: 3,
        similarity_threshold: 0.5,
      });

      if (memories.length > 0) {
        const memoryText = memories
          .map((m: any) => `- ${m.node.content}`)
          .join('\n');
        enrichedPrompt = `Context from this agent's memory:\n${memoryText}\n\nQuestion: ${prompt}`;
        memoryInjected = memories.length;
        console.info(
          `[hal-signals] graph-rag: injected ${memoryInjected} memories for ${agentId}`,
        );
      } else {
        // Distinguished from the skip and the failure paths on purpose: an
        // agent with no embedded rows returns empty here forever, and that
        // reads identically to a genuine miss unless it is named.
        console.info(
          `[hal-signals] graph-rag: 0 matches for ${agentId} (no embedded memory, or nothing above threshold)`,
        );
      }
    } catch (e: any) {
      console.warn('[hal-signals] graph-rag: injection FAILED:', e?.message ?? e);
    }
  }

  try {
    const cls = await classify(prompt);
    category = cls?.category ?? null;
    if (category === 'factual' || category === 'time-sensitive' || category === 'math') {
      // P5-A (2026-05-04): 'math' added so Pythagorean Comma BFT can fire on
      // math fabrications (HAL-T1-003: 256/243 ≠ Pythagorean Comma). Without
      // this, the *0.15 mathematics dampening lands hal_score below 0.25 and
      // there's no Layer 1 path to catch the mis-stated foundational ratio.
      const cmp = await checkCrossLLM(enrichedPrompt);

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
