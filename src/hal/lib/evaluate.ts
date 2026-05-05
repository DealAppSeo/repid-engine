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
 *   - the classifier returns category ∈ {factual, time-sensitive, math}.
 *
 * The 'math' category was added in P5-A (2026-05-04) so the Pythagorean
 * Comma BFT can fire on math fabrications (HAL-T1-003). Production
 * src/services/hal-signals.ts mirrors the same gate — the two paths must
 * stay byte-identical.
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
import { compareConsensusToClaim } from './claim-comparison';
import { checkCrossLLM } from './cross-llm';
import { classify } from './classifier';
import {
  COMMA_BAND_TIGHT_THRESHOLD,
  HAL_DEFAULT_VETO_THRESHOLD,
} from './constants';
import { extractHALSignals } from './extract';
import { computeHALScore } from './score';
import { classifyAgreementZone } from './zones';
import type {
  AgreementZone,
  CommaSeverity,
  CrossLLMSummary,
  HALContext,
  HALResult,
  HALSignals,
  HALTamperingSignal,
  StrictnessLevel,
} from './types';

const LAYER_1_GATE_CATEGORIES = new Set(['factual', 'time-sensitive', 'math']);

/** Default strictness level when caller does not specify. */
export const DEFAULT_STRICTNESS: StrictnessLevel = 4;

function normalizeStrictness(s: unknown): StrictnessLevel {
  if (s === 1 || s === 2 || s === 3 || s === 4 || s === 5) return s;
  return DEFAULT_STRICTNESS;
}

export async function evaluate(
  claimText: string,
  output: string,
  context: HALContext,
): Promise<HALResult> {
  const strictness = normalizeStrictness(context.strictness);

  const baseSignals = extractHALSignals({
    text: claimText,
    domain: context.domain,
    certainty: context.certainty,
    domainOntologies: context.domainOntologies,
  });

  let cross: CrossLLMSummary | null = null;
  let promptCategory: string | null = null;

  // Strictness L1 (Fast) skips cross-LLM entirely — extractor + score only.
  const wantsLayer1 =
    strictness >= 2 &&
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
          commaOverride: context.commaOverride,
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

  const score = computeHALScore(enrichedSignals, threshold, context.commaOverride);

  const severity: CommaSeverity | null = cross ? cross.comma_severity : null;
  let vetoed = score.vetoed || severity === 'critical';

  // ---- Phase 4 zone classification (level 4+ acts on it) ----------------
  let agreementZone: AgreementZone | null = null;
  if (strictness >= 4 && cross) {
    agreementZone = classifyAgreementZone(cross.agreement_score, context.commaOverride);
  }

  // ---- Phase 3 consensus-vs-claim comparison (level 4+) -----------------
  let consensusAnswer: string | null = null;
  let claimVsConsensusSim: number | null = null;
  let claimContradicts: boolean | null = null;
  if (
    strictness >= 4 &&
    cross &&
    Array.isArray(cross.answers_per_provider) &&
    agreementZone === 'in-band'
  ) {
    const answers = cross.answers_per_provider
      .filter(a => !a.error && typeof a.answer === 'string' && a.answer.trim().length > 0)
      .map(a => a.answer);
    if (answers.length >= 2) {
      try {
        const cmp = await compareConsensusToClaim({
          claim: claimText,
          responses: answers,
          embeddingClient: context.embeddingClient ?? null,
        });
        if (cmp) {
          consensusAnswer = cmp.consensus_answer;
          claimVsConsensusSim = cmp.similarity;
          claimContradicts = cmp.contradicts;
          if (cmp.contradicts) vetoed = true;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[hal/lib/evaluate] claim-comparison failed:', msg);
      }
    }
  }

  // ---- Phase 5 tampering detection (level 5 only) -----------------------
  let tamperingSuspected: boolean | null = null;
  let tamperingSignal: HALTamperingSignal | null = null;
  if (strictness >= 5 && cross && agreementZone === 'too-tight') {
    tamperingSuspected = true;
    tamperingSignal = {
      similarity: cross.agreement_score,
      responses: cross.answers_per_provider
        .filter(a => !a.error && a.answer)
        .map(a => a.answer),
      reason:
        `Agreement ${cross.agreement_score.toFixed(3)} above ` +
        `${COMMA_BAND_TIGHT_THRESHOLD} threshold — suspiciously tight ` +
        `consensus collapse (potential tampering, training-data ` +
        `contamination, or coordinated prompt injection).`,
    };
  }

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
    strictness,
    agreement_zone: agreementZone,
    consensus_answer: consensusAnswer,
    claim_vs_consensus_similarity: claimVsConsensusSim,
    claim_contradicts_consensus: claimContradicts,
    tampering_suspected: tamperingSuspected,
    tampering_signal: tamperingSignal,
  };
}
