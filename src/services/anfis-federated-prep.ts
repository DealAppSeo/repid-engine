/**
 * ANFIS-Ikigai v0.1 — Federated learning capture (schema-only stub)
 *
 * v0.1 captures pattern-level observations LOCALLY only. share_consent is
 * always written FALSE. v1 will add an outbound channel; that channel is
 * not implemented here and there is no place in this code where data
 * leaves the local Supabase. See docs/ANFIS-FEDERATED-LEARNING-V0-PREP.md
 * for the threat model.
 *
 * What we capture (all four functions never include raw signal text):
 *   1. rule_firing_distribution    — which fuzzy rules fired, with strength
 *   2. antagonist_correction_rate  — % of v0 scores materially adjusted by antagonist
 *   3. harmonic_dissonance_correlation — does dissonance correlate with later dismissal?
 *   4. feature_weight_drift        — how have feature weights moved over a window?
 *
 * Each capture writes one row to anfis_federated_observations.
 *
 * Patent note (P-014 §3.7): the architectural claim is that the patterns
 * themselves are sufficient federated learning signal. v0.1 demonstrates
 * the schema; v1 demonstrates the cross-user training without raw data
 * exchange — the same shape pattern that medical-AI federated training
 * uses, applied here to attention routing.
 */

import { createHash } from 'crypto';
import { db } from '../db';
import { AnfisScoreEvent } from './anfis-ikigai-scorer';
import { AntagonistEvaluation } from './anfis-antagonist';
import { HarmonicAlignment } from './anfis-circle-of-fifths';

export type FederatedPatternType =
  | 'rule_firing_distribution'
  | 'antagonist_correction_rate'
  | 'harmonic_dissonance_correlation'
  | 'feature_weight_drift';

export interface FederatedObservationRow {
  id?: string;
  profile_id?: string | null;
  pattern_type: FederatedPatternType;
  observation_payload: Record<string, unknown>;
  hash_of_inputs?: string;
  share_consent: boolean;
  created_at?: string;
}

/** Hash an arbitrary string (typically signal content) for dedup. */
function hashInput(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Write the row to anfis_federated_observations. Soft-fails: any DB error
 * is logged and swallowed so federated capture never breaks the scoring
 * path.
 */
async function persist(row: FederatedObservationRow): Promise<{ ok: boolean; id?: string }> {
  try {
    const { data, error } = await db
      .from('anfis_federated_observations')
      .insert({
        profile_id: row.profile_id ?? null,
        pattern_type: row.pattern_type,
        observation_payload: row.observation_payload,
        hash_of_inputs: row.hash_of_inputs ?? null,
        share_consent: false,
      })
      .select()
      .single();
    if (error) {
      console.warn('[anfis-federated-prep] persist failed:', error.message);
      return { ok: false };
    }
    return { ok: true, id: data?.id };
  } catch (e: any) {
    console.warn('[anfis-federated-prep] persist exception:', e?.message ?? String(e));
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 1. Rule firing distribution
// ---------------------------------------------------------------------------

/**
 * Capture which rules fired (and with what strength) for a given score
 * event. Useful federated signal: aggregating across users tells us which
 * rules are useful in practice and which never fire.
 *
 * Payload contains rule_id → firing_strength only. Never the signal text.
 */
export async function captureRuleFiringDistribution(
  profileId: string | null,
  scoreEvent: AnfisScoreEvent,
  inputHash?: string,
): Promise<{ ok: boolean; id?: string }> {
  const distribution: Record<string, number> = {};
  for (const f of scoreEvent.rule_trace.evaluation.fired) {
    distribution[f.ruleId] = round4(f.firing_strength);
  }
  const silent = scoreEvent.rule_trace.evaluation.silent.map(s => s.ruleId);

  return persist({
    profile_id: profileId,
    pattern_type: 'rule_firing_distribution',
    observation_payload: {
      fired_with_strength: distribution,
      silent_rules: silent,
      composite_score: scoreEvent.composite_score,
      total_firing: scoreEvent.rule_trace.evaluation.total_firing,
    },
    hash_of_inputs: inputHash,
    share_consent: false,
  });
}

// ---------------------------------------------------------------------------
// 2. Antagonist correction rate
// ---------------------------------------------------------------------------

/**
 * Compute the % of recent score events that were materially adjusted
 * (>= 0.05 absolute change) by the antagonist over a rolling time window.
 * This is a single number — perfectly federated-shareable when consent is
 * granted because it leaks no per-event content.
 *
 * Querying logic kept defensive: if no events exist in the window, we
 * return 0.0 and the row records lookback_count=0 so the zero is
 * distinguishable from "100% no-corrections".
 */
export async function captureAntagonistCorrectionRate(
  profileId: string,
  dateRangeDays: number = 7,
): Promise<{ ok: boolean; id?: string }> {
  const since = new Date(Date.now() - dateRangeDays * 24 * 60 * 60 * 1000).toISOString();

  // We pull antagonist events joined-by-time to score events for this profile.
  // Two queries because Supabase REST joins on RLS-locked tables can be brittle.
  const { data: scoreEvents, error: scoreErr } = await db
    .from('anfis_score_events')
    .select('id, composite_score')
    .eq('profile_id', profileId)
    .gte('scored_at', since);

  if (scoreErr) {
    console.warn('[anfis-federated-prep] correction rate score lookup failed:', scoreErr.message);
    return { ok: false };
  }
  const scoreIds = (scoreEvents ?? []).map(s => s.id);
  if (scoreIds.length === 0) {
    return persist({
      profile_id: profileId,
      pattern_type: 'antagonist_correction_rate',
      observation_payload: { lookback_count: 0, correction_rate: 0, dateRangeDays },
      share_consent: false,
    });
  }

  const { data: antagonists, error: antagonistErr } = await db
    .from('anfis_antagonist_evaluations')
    .select('score_event_id, protagonist_score, net_score, veto_triggered')
    .in('score_event_id', scoreIds);

  if (antagonistErr) {
    console.warn('[anfis-federated-prep] correction rate antagonist lookup failed:', antagonistErr.message);
    return { ok: false };
  }

  const corrections = (antagonists ?? []).filter(a =>
    Math.abs(Number(a.protagonist_score) - Number(a.net_score)) >= 0.05
  ).length;
  const vetoes = (antagonists ?? []).filter(a => a.veto_triggered).length;
  const denom = (antagonists ?? []).length;
  const correctionRate = denom > 0 ? corrections / denom : 0;

  return persist({
    profile_id: profileId,
    pattern_type: 'antagonist_correction_rate',
    observation_payload: {
      lookback_count: denom,
      corrections,
      vetoes,
      correction_rate: round4(correctionRate),
      dateRangeDays,
    },
    share_consent: false,
  });
}

// ---------------------------------------------------------------------------
// 3. Harmonic dissonance correlation
// ---------------------------------------------------------------------------

/**
 * Per-event capture: did this score event have dissonance, and what was
 * the resonance score? When paired (via score_event_id) with later
 * user_feedback_events, the cross-user aggregate becomes "do dissonant
 * scores get dismissed more often?".
 */
export async function captureHarmonicDissonanceCorrelation(
  profileId: string,
  scoreEventId: string,
  harmonic: HarmonicAlignment,
): Promise<{ ok: boolean; id?: string }> {
  return persist({
    profile_id: profileId,
    pattern_type: 'harmonic_dissonance_correlation',
    observation_payload: {
      score_event_id: scoreEventId,
      resonance_score: harmonic.resonance_score,
      dissonance_flag: harmonic.dissonance_flag,
      composite_multiplier: harmonic.composite_multiplier,
      pair_distances: {
        love_good_at:        harmonic.love_good_at_distance,
        good_at_world_needs: harmonic.good_at_world_needs_distance,
        world_needs_paid_for: harmonic.world_needs_paid_for_distance,
        paid_for_love:       harmonic.paid_for_love_distance,
      },
    },
    share_consent: false,
  });
}

// ---------------------------------------------------------------------------
// 4. Feature weight drift
// ---------------------------------------------------------------------------

/**
 * Snapshot the current per-(profile, feature) LASSO weights so that
 * federated aggregations can later compare drift across users.
 * Only the WEIGHTS travel — not the feature names paired with content.
 *
 * v0.1: weights are uniform (1.0 default) so drift is uniformly zero. The
 * row is still written for schema-shape consistency. v1 LASSO updates
 * will populate non-trivial drift.
 */
export async function captureFeatureWeightDrift(
  profileId: string,
  dateRangeDays: number = 30,
): Promise<{ ok: boolean; id?: string }> {
  const { data, error } = await db
    .from('lasso_feature_weights')
    .select('feature_name, weight, last_updated')
    .eq('profile_id', profileId);

  if (error) {
    console.warn('[anfis-federated-prep] feature weight lookup failed:', error.message);
    return { ok: false };
  }
  const weights = (data ?? []).map(r => ({
    feature_hash: createHash('sha1').update(r.feature_name).digest('hex').slice(0, 12),
    weight: Number(r.weight),
  }));

  return persist({
    profile_id: profileId,
    pattern_type: 'feature_weight_drift',
    observation_payload: {
      lookback_count: weights.length,
      dateRangeDays,
      // Hashed feature identifiers + weights only. The hash is one-way;
      // even if the row is exported later it cannot be reversed to the
      // user's keyword list. Patent-relevant privacy property.
      weights_hashed: weights,
    },
    share_consent: false,
  });
}

// ---------------------------------------------------------------------------
// Summary / read-only helper for the GET /api/v1/anfis/federated-stats route
// ---------------------------------------------------------------------------

export async function summariseFederatedObservations(
  profileId: string,
): Promise<Record<FederatedPatternType, { count: number; latest_at?: string }>> {
  const types: FederatedPatternType[] = [
    'rule_firing_distribution',
    'antagonist_correction_rate',
    'harmonic_dissonance_correlation',
    'feature_weight_drift',
  ];
  const out: any = {};
  for (const t of types) {
    const { data, error } = await db
      .from('anfis_federated_observations')
      .select('id, created_at')
      .eq('profile_id', profileId)
      .eq('pattern_type', t)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      out[t] = { count: 0 };
      continue;
    }
    const { count } = await db
      .from('anfis_federated_observations')
      .select('*', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      .eq('pattern_type', t);
    out[t] = {
      count: count ?? 0,
      latest_at: data?.[0]?.created_at,
    };
  }
  return out;
}

export { hashInput };

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
