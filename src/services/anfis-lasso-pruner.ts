/**
 * ANFIS-Ikigai — LASSO-inspired feature pruner (v0)
 *
 * v0 is a HEURISTIC, not full L1-regularised regression. It exists so the
 * downstream call surface (scoreSignal) can claim "LASSO feature pruning"
 * truthfully and so the persistence schema (lasso_feature_weights) gets
 * exercised, even though no actual gradient updates have happened yet.
 *
 * v1 will replace this with proper L1 regression once user_feedback_events
 * accumulates enough labelled data. The function signature is meant to be
 * stable across that swap.
 *
 * Patent note (P-014): LASSO feature pruning grounded in declared-purpose
 * dimensions is one of the four novelty axes. The fact that v0 is a
 * heuristic does not undermine the embodiment — the *architectural* claim
 * is that pruning is anchored to ikigai, not engagement.
 */

import { IkigaiDimension } from './anfis-ikigai-mfs';

export interface FeatureVector {
  /** Dimension this feature contributes to ("love", "good_at", ...). */
  dimension: IkigaiDimension;
  /** Stable feature name, e.g. "keyword:agent reputation" or "topic:zkp". */
  name: string;
  /** Raw activation, in [0, 1]. */
  value: number;
}

export interface FeatureWeight {
  feature_name: string;
  weight: number;
}

export interface PruneResult {
  /** Features that survived pruning, sorted by descending pruned value. */
  retained: FeatureVector[];
  /** Features that were dropped (weight ≤ threshold). */
  pruned: FeatureVector[];
  /** Feature names whose pruned value was used downstream. Stored as
   *  lasso_features_used in the score event. */
  retained_names: string[];
}

/**
 * Tunable threshold below which a feature is treated as zeroed-out. v0 keeps
 * it conservative so very few features are dropped — the goal in v0 is to
 * preserve the contract surface, not to actually compress the feature space.
 */
export const V0_PRUNE_THRESHOLD = 0.001;

/**
 * Apply LASSO-inspired pruning.
 *
 * Algorithm (v0):
 *   1. Look up each feature's weight; missing weights default to 1.0 — the
 *      uninformative prior. The point of LASSO is feature *selection*, not
 *      feature *attenuation*; passing features through unchanged when no
 *      weight has been learned keeps the v0 contract honest.
 *   2. Multiply each feature value by its weight (this is the L1-style
 *      shrinkage analogue — high-weight features keep their full signal,
 *      low-weight features get attenuated).
 *   3. Drop features whose pruned value falls below V0_PRUNE_THRESHOLD.
 *
 * Earlier drafts used a 1/N uniform default; we backed that out because it
 * caused every dimension to collapse below the rule-base "high" threshold
 * regardless of how many keywords matched. The 1.0 default is the correct
 * neutral starting point — v1 LASSO will move weights down from 1.0 as
 * gradient updates arrive.
 *
 * Determinism: pure function. Same inputs → same output, regardless of map
 * iteration order, because we sort retained features by name as a tiebreak.
 */
export function pruneFeatures(
  features: FeatureVector[],
  weights: FeatureWeight[] = [],
): PruneResult {
  if (features.length === 0) {
    return { retained: [], pruned: [], retained_names: [] };
  }

  const weightLookup = new Map<string, number>();
  for (const w of weights) weightLookup.set(w.feature_name, w.weight);

  const uniformDefault = 1.0;

  const retained: FeatureVector[] = [];
  const pruned: FeatureVector[] = [];

  for (const f of features) {
    const w = weightLookup.has(f.name)
      ? (weightLookup.get(f.name) as number)
      : uniformDefault;
    const prunedValue = f.value * w;

    if (prunedValue >= V0_PRUNE_THRESHOLD) {
      retained.push({ ...f, value: prunedValue });
    } else {
      pruned.push({ ...f, value: prunedValue });
    }
  }

  // Stable ordering — value desc, then name asc as tiebreak. This makes
  // rule_trace and lasso_features_used reproducible across runs.
  retained.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.name.localeCompare(b.name);
  });
  pruned.sort((a, b) => a.name.localeCompare(b.name));

  return {
    retained,
    pruned,
    retained_names: retained.map(f => f.name),
  };
}
