/**
 * Top-level HAL evaluation entry point.
 *
 * Composes:
 *   1. extractHALSignals (Phase 3)        → 5-signal block
 *   2. classify (Phase 4, optional)       → Layer 0 prompt category gate
 *   3. checkCrossLLM (Phase 4, optional)  → Layer 1 agreement + Comma BFT
 *   4. computeHALScore (real)             → final hal_score + base vetoed
 *
 * Layer 1 (cross-LLM) only runs when:
 *   - context.providers has ≥1 entry, AND
 *   - context.prompt is provided, AND
 *   - the classifier returns category ∈ {factual, time-sensitive}.
 *
 * If context.classifierProvider is omitted but providers and prompt are
 * present, Layer 1 still runs (caller has opted into cross-LLM, the
 * gate is a cost-saver not a correctness gate).
 *
 * Final veto = (hal_score >= threshold) OR (comma_severity === 'critical').
 * The Comma BFT critical-veto is patent-load-bearing (P-003) — preserved
 * verbatim from src/services/hal-signals.ts:extractHALSignalsWithCrossLLM
 * + the consumer-side veto compose at /score-event and /api/v1/hal/signals.
 */
import { checkCrossLLM } from './cross-llm';
import { classify } from './classifier';
import { HAL_DEFAULT_VETO_THRESHOLD } from './constants';
import { extractHALSignals } from './extract';
import { computeHALScore } from './score';
import type {
  CommaSeverity,
  CrossLLMSummary,
  HALContext,
  HALResult,
  HALSignals,
} from './types';

const LAYER_1_GATE_CATEGORIES = new Set(['factual', 'time-sensitive']);

export async function evaluate(
  claimText: string,
  output: string,
  context: HALContext,
): Promise<HALResult> {
  const baseSignals = extractHALSignals({
    text: claimText,
    domain: context.domain,
    certainty: context.certainty,
    domainOntologies: context.domainOntologies,
  });

  let cross: CrossLLMSummary | null = null;
  let promptCategory: string | null = null;

  const wantsLayer1 =
    Array.isArray(context.providers) &&
    context.providers.length > 0 &&
    typeof context.prompt === 'string' &&
    context.prompt.trim().length > 0;

  if (wantsLayer1) {
    const classifierProvider = context.classifierProvider;
    let runLayer1 = true;
    if (classifierProvider !== undefined) {
      try {
        const cls = await classify(context.prompt!, {
          provider: classifierProvider ?? null,
          supabase: context.supabase ?? null,
        });
        promptCategory = cls.category ?? null;
        runLayer1 = LAYER_1_GATE_CATEGORIES.has(promptCategory ?? '');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[hal/lib/evaluate] classifier failed:', msg);
      }
    }

    if (runLayer1) {
      try {
        cross = await checkCrossLLM(context.prompt!, {
          providers: context.providers!,
          embeddingClient: context.embeddingClient ?? null,
          supabase: context.supabase ?? null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[hal/lib/evaluate] cross-LLM failed:', msg);
      }
    }
  }

  const enrichedSignals: HALSignals = {
    ...baseSignals,
    agreement_score: cross ? cross.agreement_score : null,
    prompt_category: promptCategory,
    comma_veto: cross ? cross.comma_veto : null,
    comma_gap: cross ? cross.comma_gap : null,
    comma_severity: cross ? cross.comma_severity : null,
  };

  const threshold =
    typeof context.threshold === 'number' && Number.isFinite(context.threshold)
      ? context.threshold
      : HAL_DEFAULT_VETO_THRESHOLD;

  const score = computeHALScore(enrichedSignals, threshold);

  const severity: CommaSeverity | null = cross ? cross.comma_severity : null;
  const vetoed = score.vetoed || severity === 'critical';

  // void output — kept in signature for forward-compat with separate
  // claim/output evaluations; the Path A extractor scores claimText.
  void output;

  return {
    signals: enrichedSignals,
    hal_score: score.hal_score,
    vetoed,
    threshold: score.threshold,
    formula: score.formula,
    cross_llm: cross,
  };
}
