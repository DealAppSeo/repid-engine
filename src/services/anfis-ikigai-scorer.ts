/**
 * ANFIS-Ikigai — Scoring engine (v0)
 *
 * scoreSignal() is the heart of the v0 prototype. It takes one
 * AttentionSignal and one IkigaiProfile, runs the full ANFIS-LASSO pipeline,
 * persists an audit-ready score event, and returns the typed result.
 *
 * Pipeline:
 *   1. Feature extraction          — keyword overlap, per dimension
 *   2. LASSO-inspired pruning      — anfis-lasso-pruner.ts
 *   3. Per-dimension raw alignment — sum of pruned feature values, normalised
 *   4. Fuzzification + rule firing — anfis-ikigai-rules.ts (Sugeno)
 *   5. Anticipatory delta lookup   — anfis-anticipatory.ts
 *   6. Persist anfis_score_events   — append-only audit row
 *
 * Determinism: pure given identical DB state. The keyword extractor is
 * case-insensitive substring match (no NLP, no embeddings). v1 will swap
 * embeddings in behind the same FeatureVector contract.
 *
 * Latency budget: v0 target is <50ms, achieved by:
 *   - no LLM call in the scoring path;
 *   - O(N*K) keyword check where N=signal-words, K=profile-keywords;
 *   - one DB read for priors, one DB write for the event.
 *
 * Patent note (P-014): every score event includes a rule_trace JSONB
 * payload that explains exactly which rules fired with what strength on
 * what evidence. This is the "explainability surface" claim and it is
 * computed without any post-hoc reconstruction.
 */

import { db } from '../db';
import {
  evaluateRules,
  RawAlignment,
  V0_RULE_BASE,
  RuleEvaluation,
} from './anfis-ikigai-rules';
import {
  pruneFeatures,
  FeatureVector,
  FeatureWeight,
} from './anfis-lasso-pruner';
import {
  computeAnticipatoryDelta,
  computeAnticipatoryDeltaPure,
  AnticipatoryResult,
} from './anfis-anticipatory';
import { IkigaiDimension } from './anfis-ikigai-mfs';
import {
  computeHarmonicAlignment,
  HarmonicAlignment,
} from './anfis-circle-of-fifths';
import {
  scoreFromPerspectives,
  SbfaResult,
  PerspectiveScore,
  SbfaOptions,
} from './anfis-sbfa-perspectives';
import {
  evaluateAntagonist,
  AntagonistEvaluation,
} from './anfis-antagonist';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AttentionSignal {
  /** UUID once persisted; may be omitted for in-memory scoring. */
  id?: string;
  source_type: string;
  source_id?: string;
  content: string;
  context?: Record<string, unknown>;
}

export interface IkigaiDimensionPayload {
  /** Keyword/concept strings the user associates with this dimension. */
  keywords: string[];
  /** Optional pre-tuned LASSO weights, one per feature. */
  weight_features?: FeatureWeight[];
  /** Reserved for v1 — per-dimension MF parameters. */
  membership_function?: Record<string, unknown>;
}

export interface IkigaiProfile {
  id?: string;
  user_id: string;
  profile_version: number;
  love_dimension:        IkigaiDimensionPayload;
  good_at_dimension:     IkigaiDimensionPayload;
  world_needs_dimension: IkigaiDimensionPayload;
  paid_for_dimension:    IkigaiDimensionPayload;
  active?: boolean;
}

export interface AnfisScoreEvent {
  id?: string;
  signal_id: string;
  profile_id: string;
  love_alignment: number;
  good_at_alignment: number;
  world_needs_alignment: number;
  paid_for_alignment: number;
  composite_score: number;
  anticipatory_delta: number;
  rule_trace: RuleTraceEntry;
  latency_ms: number;
  lasso_features_used: string[];
  audit_chain_hash?: string | null;
  scored_at?: string;
  // -- v0.1 enrichments — only populated when mode !== 'v0' --
  /** Harmonic alignment record. Present when mode is 'v0.1-fast' or 'v0.1-full'. */
  harmonic?: HarmonicAlignment;
  /** Multi-perspective scoring result. Present only when mode is 'v0.1-full'. */
  perspectives?: SbfaResult;
  /** Structured antagonist evaluation. Present only when mode is 'v0.1-full'. */
  antagonist?: AntagonistEvaluation;
  /** Final score after harmonic multiplier and antagonist correction.
   *  Present whenever harmonic or antagonist enrichment is present. */
  final_net_score?: number;
  /** Echo of the mode the engine ran in. Useful for downstream filters. */
  mode?: ScoreSignalMode;
}

/**
 * Full structured rule_trace payload that lands in the JSONB column. Every
 * field is here to make the score event independently re-explainable months
 * after the fact, without re-running the engine.
 */
export interface RuleTraceEntry {
  schema_version: 'anfis-ikigai-v0';
  raw_alignment: RawAlignment;
  evaluation: RuleEvaluation;
  anticipatory: AnticipatoryResult;
  feature_summary: {
    extracted: number;
    retained: number;
    pruned: number;
  };
}

// ---------------------------------------------------------------------------
// Scoring options
// ---------------------------------------------------------------------------

export type ScoreSignalMode = 'v0' | 'v0.1-fast' | 'v0.1-full';

export interface ScoreSignalOptions {
  /** When false, the engine does not write to anfis_score_events. Used by
   *  tests and by the in-memory /score endpoint variant. */
  persist?: boolean;
  /** Inject anticipatory priors instead of querying Supabase. Tests use this
   *  to keep the scorer hermetic. */
  injected_priors?: number[];
  /** Override the rule base — useful for ablation studies. v0 callers should
   *  leave this undefined. */
  rules?: typeof V0_RULE_BASE;
  /** v0.1 mode selector. Default 'v0' preserves the existing contract. */
  mode?: ScoreSignalMode;
  /** Forwarded to the SBFA orchestrator when mode === 'v0.1-full'. */
  sbfa?: SbfaOptions;
  /** v0.1: when true and the score event is persisted, also write the
   *  v0.1 enrichment rows to anfis_perspective_scores /
   *  anfis_harmonic_alignment / anfis_antagonist_evaluations. Default true
   *  whenever options.persist is true and mode !== 'v0'. */
  persist_enrichments?: boolean;
}

// ---------------------------------------------------------------------------
// Feature extraction (v0 — keyword substring overlap)
// ---------------------------------------------------------------------------

const DIMENSION_KEYS: IkigaiDimension[] = [
  'love',
  'good_at',
  'world_needs',
  'paid_for',
];

function dimensionPayload(
  profile: IkigaiProfile,
  dim: IkigaiDimension,
): IkigaiDimensionPayload {
  switch (dim) {
    case 'love':        return profile.love_dimension;
    case 'good_at':     return profile.good_at_dimension;
    case 'world_needs': return profile.world_needs_dimension;
    case 'paid_for':    return profile.paid_for_dimension;
  }
}

/**
 * v0 feature extractor: lowercased substring containment of each profile
 * keyword in the signal content. One feature per (dimension, keyword) hit.
 * Value is fixed at 1.0 because v0 doesn't differentiate weak vs strong
 * matches — that is what LASSO weights and v1 embeddings are for.
 */
export function extractFeatures(
  signal: AttentionSignal,
  profile: IkigaiProfile,
): FeatureVector[] {
  const text = (signal.content ?? '').toLowerCase();
  if (!text) return [];

  const out: FeatureVector[] = [];
  for (const dim of DIMENSION_KEYS) {
    const payload = dimensionPayload(profile, dim);
    for (const kw of payload.keywords ?? []) {
      const needle = kw.toLowerCase().trim();
      if (!needle) continue;
      if (text.includes(needle)) {
        out.push({
          dimension: dim,
          name: `kw:${dim}:${needle}`,
          value: 1.0,
        });
      }
    }
  }
  return out;
}

/**
 * Convert pruned features into the four-dimension RawAlignment. Each
 * dimension's alignment is its retained feature mass divided by the
 * keyword count for that dimension (plus 1 to avoid division by zero
 * and to keep scores in [0, 1]).
 */
export function rawAlignmentFromFeatures(
  retained: FeatureVector[],
  profile: IkigaiProfile,
): RawAlignment {
  const sums: Record<IkigaiDimension, number> = {
    love: 0, good_at: 0, world_needs: 0, paid_for: 0,
  };
  for (const f of retained) sums[f.dimension] += f.value;

  return {
    love:        normaliseDim(sums.love,        profile.love_dimension.keywords.length),
    good_at:     normaliseDim(sums.good_at,     profile.good_at_dimension.keywords.length),
    world_needs: normaliseDim(sums.world_needs, profile.world_needs_dimension.keywords.length),
    paid_for:    normaliseDim(sums.paid_for,    profile.paid_for_dimension.keywords.length),
  };
}

/**
 * Saturating-target normalisation:
 *
 *   - 0 hits      → 0     (low fuzzy set saturates)
 *   - 1 hit       → ~0.5  (medium fuzzy set saturates near here)
 *   - 2+ hits     → 1.0   (high fuzzy set saturates)
 *
 * Independent of keyword-count by design. With keyword-only feature
 * extraction, hit COUNT is far more informative than hit RATIO — a love
 * dimension with 7 declared keywords and 2 hits is just as aligned as a
 * paid_for dimension with 5 keywords and 2 hits. v1 with embeddings will
 * replace this with cosine similarity per dimension.
 */
const V0_HIT_TARGET = 2;

function normaliseDim(featureMass: number, keywordCount: number): number {
  if (keywordCount <= 0) return 0;
  const v = featureMass / V0_HIT_TARGET;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Main scoring entry point
// ---------------------------------------------------------------------------

export async function scoreSignal(
  signal: AttentionSignal,
  profile: IkigaiProfile,
  options: ScoreSignalOptions = {},
): Promise<AnfisScoreEvent> {
  const t0 = Date.now();

  // 1. Feature extraction
  const features = extractFeatures(signal, profile);

  // 2. LASSO-inspired pruning. Aggregate weights from all four dimensions.
  const allWeights: FeatureWeight[] = [];
  for (const dim of DIMENSION_KEYS) {
    const payload = dimensionPayload(profile, dim);
    for (const w of payload.weight_features ?? []) allWeights.push(w);
  }
  const pruneResult = pruneFeatures(features, allWeights);

  // 3. Per-dimension raw alignment
  const raw = rawAlignmentFromFeatures(pruneResult.retained, profile);

  // 4. Fuzzification + rule firing
  const evaluation = evaluateRules(raw, options.rules ?? V0_RULE_BASE);

  // 5. Anticipatory delta — DB lookup unless caller injects priors.
  const anticipatory = options.injected_priors !== undefined
    ? computeAnticipatoryDeltaPure(options.injected_priors, evaluation.composite)
    : (signal.id
        ? await computeAnticipatoryDelta(signal.id, evaluation.composite)
        : { delta: 0, trend: 'stable' as const, lookback_count: 0, prior_mean: 0 });

  const latencyMs = Date.now() - t0;

  const ruleTrace: RuleTraceEntry = {
    schema_version: 'anfis-ikigai-v0',
    raw_alignment: raw,
    evaluation,
    anticipatory,
    feature_summary: {
      extracted: features.length,
      retained: pruneResult.retained.length,
      pruned:   pruneResult.pruned.length,
    },
  };

  const event: AnfisScoreEvent = {
    signal_id: signal.id ?? '',
    profile_id: profile.id ?? '',
    love_alignment:        round4(raw.love),
    good_at_alignment:     round4(raw.good_at),
    world_needs_alignment: round4(raw.world_needs),
    paid_for_alignment:    round4(raw.paid_for),
    composite_score:    round4(evaluation.composite),
    anticipatory_delta: round4(anticipatory.delta),
    rule_trace: ruleTrace,
    latency_ms: latencyMs,
    lasso_features_used: pruneResult.retained_names,
    audit_chain_hash: null,
  };

  // 6. Persist (unless tests opt out)
  if (options.persist && signal.id && profile.id) {
    const { data, error } = await db
      .from('anfis_score_events')
      .insert({
        signal_id: signal.id,
        profile_id: profile.id,
        love_alignment:        event.love_alignment,
        good_at_alignment:     event.good_at_alignment,
        world_needs_alignment: event.world_needs_alignment,
        paid_for_alignment:    event.paid_for_alignment,
        composite_score:    event.composite_score,
        anticipatory_delta: event.anticipatory_delta,
        rule_trace: event.rule_trace,
        latency_ms: event.latency_ms,
        lasso_features_used: event.lasso_features_used,
        audit_chain_hash: null,
      })
      .select()
      .single();

    if (error) {
      console.warn('[anfis-ikigai-scorer] persist failed:', error.message);
    } else if (data) {
      event.id = data.id;
      event.scored_at = data.scored_at;
    }
  }

  // 7. v0.1 enrichments. Default mode is 'v0' which short-circuits here so
  // existing v0 callers see the exact same return shape and behaviour.
  const mode: ScoreSignalMode = options.mode ?? 'v0';
  if (mode !== 'v0') {
    event.mode = mode;
    await applyV01Enrichments(event, signal, profile, options);
  }

  return event;
}

// ---------------------------------------------------------------------------
// v0.1 — Harmonic / SBFA / Antagonist orchestration
// ---------------------------------------------------------------------------

async function applyV01Enrichments(
  event: AnfisScoreEvent,
  signal: AttentionSignal,
  profile: IkigaiProfile,
  options: ScoreSignalOptions,
): Promise<void> {
  const mode: ScoreSignalMode = options.mode ?? 'v0';
  const persistEnrichments = options.persist_enrichments ?? !!options.persist;

  // Harmonic alignment runs in both v0.1-fast and v0.1-full. No LLM calls.
  const harmonic = computeHarmonicAlignment({
    love:        event.love_alignment,
    good_at:     event.good_at_alignment,
    world_needs: event.world_needs_alignment,
    paid_for:    event.paid_for_alignment,
  });
  event.harmonic = harmonic;

  let perspectives: SbfaResult | undefined;
  let antagonist: AntagonistEvaluation | undefined;
  if (mode === 'v0.1-full') {
    // SBFA — five parallel LLM calls with mock fallback.
    perspectives = await scoreFromPerspectives(signal, profile, event.composite_score, options.sbfa ?? {});
    event.perspectives = perspectives;

    // Promote the antagonist perspective to the structured veto path.
    const antagonistVoice = perspectives.scores.find(s => s.perspective_role === 'antagonist');
    const antagonistScore = antagonistVoice?.composite_score ?? 0;
    const optionsForEval = antagonistVoice?.rationale
      ? { rationale: antagonistVoice.rationale }
      : {};
    antagonist = evaluateAntagonist(
      signal,
      profile,
      event.composite_score,
      antagonistScore,
      optionsForEval,
    );
    event.antagonist = antagonist;
  }

  // Final net score:
  //   v0.1-fast:    composite × harmonic_multiplier
  //   v0.1-full:    composite × harmonic_multiplier × (1 - 0.5 × antagonist)
  let net = event.composite_score * harmonic.composite_multiplier;
  if (antagonist) {
    net = net * (1 - 0.5 * antagonist.antagonist_score);
  }
  event.final_net_score = round4(clamp01(net));

  if (persistEnrichments && event.id) {
    await persistEnrichmentRows(event, perspectives, antagonist, harmonic);
  }
}

async function persistEnrichmentRows(
  event: AnfisScoreEvent,
  perspectives: SbfaResult | undefined,
  antagonist: AntagonistEvaluation | undefined,
  harmonic: HarmonicAlignment,
): Promise<void> {
  if (!event.id) return;
  // Harmonic — always when v0.1.
  try {
    await db.from('anfis_harmonic_alignment').insert({
      score_event_id: event.id,
      love_good_at_distance:        harmonic.love_good_at_distance,
      good_at_world_needs_distance: harmonic.good_at_world_needs_distance,
      world_needs_paid_for_distance: harmonic.world_needs_paid_for_distance,
      paid_for_love_distance:       harmonic.paid_for_love_distance,
      resonance_score:              harmonic.resonance_score,
      dissonance_flag:              harmonic.dissonance_flag,
      pythagorean_comma_multiplier: harmonic.pythagorean_comma_multiplier,
    });
  } catch (e: any) {
    console.warn('[anfis-ikigai-scorer] harmonic persist failed:', e?.message ?? String(e));
  }

  if (perspectives) {
    try {
      const rows = perspectives.scores.map((p: PerspectiveScore) => ({
        score_event_id: event.id,
        perspective_role: p.perspective_role,
        model_used:       p.model_used,
        composite_score:  round4(p.composite_score),
        rationale:        p.rationale,
        latency_ms:       p.latency_ms,
        cost_usd:         round8(p.cost_usd),
      }));
      await db.from('anfis_perspective_scores').insert(rows);
    } catch (e: any) {
      console.warn('[anfis-ikigai-scorer] perspectives persist failed:', e?.message ?? String(e));
    }
  }

  if (antagonist) {
    try {
      await db.from('anfis_antagonist_evaluations').insert({
        score_event_id: event.id,
        argument_against: antagonist.argument_against,
        counter_evidence_keywords: antagonist.counter_evidence_keywords,
        antagonist_score: antagonist.antagonist_score,
        protagonist_score: antagonist.protagonist_score,
        net_score: antagonist.net_score,
        veto_triggered: antagonist.veto_triggered,
      });
    } catch (e: any) {
      console.warn('[anfis-ikigai-scorer] antagonist persist failed:', e?.message ?? String(e));
    }
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
