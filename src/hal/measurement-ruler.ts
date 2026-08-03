/**
 * HAL MEASUREMENT RULER — refusal, not convention.
 * OUTPUT_PATH: src/hal/measurement-ruler.ts
 *
 * A measurement of HAL is the string
 *
 *     F1 = 0.8812 on corpus hal-fact-check-s2-v1@sha256:2f9c1a… (395 cases) at 2 families, strictness 2
 *
 * or it is not a measurement. This module makes the second half of that sentence structurally
 * mandatory: there is no code path here that yields an accuracy number without its ruler, and the
 * failure mode for omitting one is a thrown `MissingRulerError`, not a missing field someone notices
 * six weeks later.
 *
 * WHY A REFUSAL AND NOT A CONVENTION
 * ----------------------------------
 * The convention already existed and it already failed. `hal_validation_summaries` has an
 * `f1_score` column and a `harness_version` column; the convention was "put the configuration in
 * harness_version". Verified against the live DB on 2026-08-03: every row says `1.0.0` or a
 * hand-typed variant, and two runs on 2026-07-04 over the SAME 1000 case ids recorded F1 0.344 and
 * F1 0.798 under an identical `harness_version`. A field you are asked to fill in politely is a field
 * that ends up holding `1.0.0`. So the ruler is a required constructor argument instead.
 *
 * WHAT "CONFIGURATION WIDTH" MEANS, AND WHY IT IS A RANGE
 * ------------------------------------------------------
 * HAL's veto requires a quorum across independent model FAMILIES, so the number of families actually
 * reached is the width of the instrument. Verified on the live `hal_runner_results` table: within the
 * single run `ga-internal-2026-06-09`, 312 cases were judged with 1 family, 9 with 2, 1 with 3 — and
 * an earlier run recorded 43 cases with an EMPTY provider list. The nominal configuration said one
 * thing; the run delivered another, per case, silently.
 *
 * Therefore width is recorded as `familiesConfigured` alongside the OBSERVED `familiesMin`/
 * `familiesMax`. When observed < configured the run was degraded, and a degraded run does not yield a
 * quality number — see ./measurement-integrity, which is what turns that into a refusal.
 *
 * HISTORICAL NUMBERS
 * ------------------
 * Numbers whose ruler cannot be established are NOT reconstructed here. They are represented with
 * `UNATTRIBUTED` and format with their ruler fields spelled `UNKNOWN`, so an un-sourced number is
 * visibly un-sourced everywhere it appears rather than quietly acquiring authority. Recording one as
 * a current measurement is refused.
 *
 * PURITY: no I/O, no env reads, no DB. This module decides whether a number may be spoken, not what
 * the number is; it never computes or alters a score, a threshold or a veto.
 */
import {
  CorpusManifest,
  corpusComparabilityFault,
  describeCorpus,
  shortHash,
} from './corpus-manifest';

/** HAL pipeline strictness. 1 = deterministic extractor, 2 = cross-LLM fact-check quorum. */
export type HalStrictness = 1 | 2;

/**
 * The instrument's configuration at the time of the run.
 *
 * `familiesConfigured` is what the operator asked for. `familiesMin`/`familiesMax` are what the run
 * actually achieved across its cases. They differ whenever a provider was down, rate-limited, or
 * holding a dead key — which is exactly the case that must never read as a quality change.
 */
export interface ConfigurationWidth {
  /** Distinct model families the run was configured to consult. */
  familiesConfigured: number;
  /** Fewest distinct families actually reached on any single case. */
  familiesMin: number;
  /** Most distinct families actually reached on any single case. */
  familiesMax: number;
  /** Resolved HAL pipeline strictness. */
  strictness: HalStrictness;
  /** Whether a decision required quorum (HAL_DECISION_REQUIRES_QUORUM at run time). */
  decisionRequiresQuorum: boolean;
  /** Whether a penalty required quorum (HAL_PENALTY_REQUIRES_QUORUM at run time). */
  penaltyRequiresQuorum: boolean;
}

/** Corpus identity + instrument configuration. Together: the ruler. */
export interface MeasurementRuler {
  corpus: CorpusManifest;
  width: ConfigurationWidth;
  /** Optional engine commit, for reproducing the run. Metadata; does not affect comparability logic. */
  engineCommit?: string;
}

/** Sentinel for a historical number whose ruler could not be established. Never reconstructed. */
export const UNATTRIBUTED = 'UNATTRIBUTED' as const;
export type Unattributed = typeof UNATTRIBUTED;

/** The metrics this module will let you speak, all requiring a ruler. */
export type AccuracyMetric = 'f1' | 'precision' | 'recall' | 'accuracy' | 'false_positive_rate';

/** A confusion matrix. The raw counts are always safe to record; the RATIOS are what need a ruler. */
export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** An accuracy number that is allowed to exist, because it carries its ruler. */
export interface RuledMeasurement {
  matrix: ConfusionMatrix;
  metrics: Record<AccuracyMetric, number | null>;
  ruler: MeasurementRuler;
  /** Canonical one-line citation for the headline metric. */
  citation: string;
}

/** Thrown when someone tries to record or compare an accuracy number without a usable ruler. */
export class MissingRulerError extends Error {
  /** Which ruler components were absent or unusable. */
  readonly missing: string[];
  constructor(missing: string[], context?: string) {
    super(
      `[hal-measurement] refusing to record an accuracy number without its ruler` +
        (context ? ` (${context})` : '') +
        `. Missing or invalid: ${missing.join(', ')}. ` +
        `A measurement is "F1 = x on corpus <id>@<hash> at <N> families, strictness <s>" or it is not a measurement.`,
    );
    this.name = 'MissingRulerError';
    this.missing = missing;
  }
}

/** Thrown when two numbers taken with different rulers are compared. */
export class IncomparableMeasurementError extends Error {
  constructor(reason: string) {
    super(`[hal-measurement] refusing to compare: ${reason}`);
    this.name = 'IncomparableMeasurementError';
  }
}

function isPositiveInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}
function isNonNegInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Validate a ruler, returning the list of problems. Empty list = usable.
 * Exported so callers can surface every problem at once rather than one throw at a time.
 */
export function rulerFaults(ruler: MeasurementRuler | Unattributed | null | undefined): string[] {
  if (ruler === UNATTRIBUTED) return ['ruler is UNATTRIBUTED (historical number, provenance unknown)'];
  if (!ruler) return ['ruler is absent'];

  const faults: string[] = [];
  const c = ruler.corpus;
  if (!c) {
    faults.push('corpus manifest is absent');
  } else {
    if (!c.corpusId?.trim()) faults.push('corpus.corpusId is empty');
    if (!/^[a-z0-9]+:[0-9a-f]{64}$/.test(c.contentHash ?? '')) {
      faults.push(`corpus.contentHash is not a full <algo>:<64 hex> digest (got ${JSON.stringify(c.contentHash)})`);
    }
    if (!isPositiveInt(c.caseCount)) faults.push('corpus.caseCount must be a positive integer');
  }

  const w = ruler.width;
  if (!w) {
    faults.push('configuration width is absent');
  } else {
    if (!isPositiveInt(w.familiesConfigured)) faults.push('width.familiesConfigured must be a positive integer');
    if (!isNonNegInt(w.familiesMin)) faults.push('width.familiesMin must be a non-negative integer');
    if (!isNonNegInt(w.familiesMax)) faults.push('width.familiesMax must be a non-negative integer');
    if (isNonNegInt(w.familiesMin) && isNonNegInt(w.familiesMax) && w.familiesMin > w.familiesMax) {
      faults.push(`width.familiesMin (${w.familiesMin}) exceeds width.familiesMax (${w.familiesMax})`);
    }
    if (w.strictness !== 1 && w.strictness !== 2) faults.push('width.strictness must be 1 or 2');
    if (typeof w.decisionRequiresQuorum !== 'boolean') faults.push('width.decisionRequiresQuorum must be boolean');
    if (typeof w.penaltyRequiresQuorum !== 'boolean') faults.push('width.penaltyRequiresQuorum must be boolean');
  }
  return faults;
}

/** Throw unless the ruler is complete and internally consistent. */
export function assertRuler(
  ruler: MeasurementRuler | Unattributed | null | undefined,
  context?: string,
): asserts ruler is MeasurementRuler {
  const faults = rulerFaults(ruler);
  if (faults.length > 0) throw new MissingRulerError(faults, context);
}

/** `at 2 families, strictness 2` — with the observed range shown when the run degraded. */
export function describeWidth(w: ConfigurationWidth): string {
  const observed =
    w.familiesMin === w.familiesMax
      ? `${w.familiesMax} families`
      : `${w.familiesMin}-${w.familiesMax} families (observed)`;
  const degraded = w.familiesMin < w.familiesConfigured ? ` [DEGRADED: configured ${w.familiesConfigured}]` : '';
  return `at ${observed}${degraded}, strictness ${w.strictness}`;
}

/** The full ruler as one human-readable clause. */
export function describeRuler(ruler: MeasurementRuler): string {
  return `on corpus ${describeCorpus(ruler.corpus)} ${describeWidth(ruler.width)}`;
}

/**
 * Format one metric with its ruler. The ONLY sanctioned way to render a HAL accuracy number as text.
 * Refuses an incomplete ruler; renders an `UNATTRIBUTED` number as visibly un-sourced.
 */
export function formatMeasurement(
  metric: AccuracyMetric | string,
  value: number | null,
  ruler: MeasurementRuler | Unattributed,
): string {
  const label = metric.toUpperCase();
  const shown = value === null || Number.isNaN(value) ? 'n/a' : value.toFixed(4);
  if (ruler === UNATTRIBUTED) {
    return `${label} = ${shown} on corpus UNKNOWN@UNKNOWN at UNKNOWN families, strictness UNKNOWN — NOT COMPARABLE (provenance never established)`;
  }
  assertRuler(ruler, `formatting ${label}`);
  return `${label} = ${shown} ${describeRuler(ruler)}`;
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/**
 * Derive the metric set from a confusion matrix.
 *
 * A zero denominator yields `null`, never 0 and never a silently substituted 1. The pre-existing
 * `scoreBenchmark` used `(tp + fp || 1)`, which turns "no positive predictions at all" into a
 * precision of 0/1 = 0 — indistinguishable from a real precision of 0. `null` says "undefined here".
 */
export function metricsFromMatrix(m: ConfusionMatrix): Record<AccuracyMetric, number | null> {
  const precision = ratio(m.tp, m.tp + m.fp);
  const recall = ratio(m.tp, m.tp + m.fn);
  const f1 = ratio(2 * m.tp, 2 * m.tp + m.fp + m.fn);
  return {
    precision,
    recall,
    f1,
    accuracy: ratio(m.tp + m.tn, m.tp + m.fp + m.fn + m.tn),
    false_positive_rate: ratio(m.fp, m.fp + m.tn),
  };
}

/**
 * THE GATE. Build a recordable measurement — the only sanctioned way to turn a confusion matrix into
 * quotable accuracy numbers. Refuses without a complete ruler.
 *
 * `headline` selects which metric the returned `citation` string cites (default F1).
 *
 * Note this gate deliberately does NOT ask whether the run was environmentally sound; that is a
 * separate question with a separate answer. Callers on the real measurement path pass their result
 * through `assertQualityMeasurable` in ./measurement-integrity first, so a run crippled by a dead
 * provider key is rejected as an environment fault before it ever reaches this function.
 */
export function recordMeasurement(args: {
  matrix: ConfusionMatrix;
  ruler: MeasurementRuler | Unattributed | null | undefined;
  headline?: AccuracyMetric;
}): RuledMeasurement {
  const { matrix } = args;
  for (const k of ['tp', 'fp', 'fn', 'tn'] as const) {
    if (!isNonNegInt(matrix?.[k])) {
      throw new MissingRulerError([`matrix.${k} must be a non-negative integer`], 'recordMeasurement');
    }
  }
  assertRuler(args.ruler, 'recordMeasurement');
  const ruler = args.ruler;

  // The corpus must be able to contain the cases actually scored, or the ruler describes a different
  // population than the one measured — which is the original bug in miniature.
  const scored = matrix.tp + matrix.fp + matrix.fn + matrix.tn;
  if (scored > ruler.corpus.caseCount) {
    throw new MissingRulerError(
      [
        `matrix totals ${scored} scored cases but corpus ${ruler.corpus.corpusId} holds only ` +
          `${ruler.corpus.caseCount} — the ruler does not describe the population measured`,
      ],
      'recordMeasurement',
    );
  }

  const metrics = metricsFromMatrix(matrix);
  const headline = args.headline ?? 'f1';
  return {
    matrix,
    metrics,
    ruler,
    citation: formatMeasurement(headline, metrics[headline], ruler),
  };
}

/**
 * Compare two measurements, refusing when they were taken with different rulers.
 * This is the function whose absence let 0.34 and 0.890 be discussed as a trend.
 */
export function assertComparable(a: RuledMeasurement, b: RuledMeasurement): void {
  const corpusFault = corpusComparabilityFault(a.ruler.corpus, b.ruler.corpus);
  if (corpusFault) throw new IncomparableMeasurementError(corpusFault);

  const aw = a.ruler.width;
  const bw = b.ruler.width;
  if (aw.strictness !== bw.strictness) {
    throw new IncomparableMeasurementError(
      `different strictness (${aw.strictness} vs ${bw.strictness}) — strictness 1 and 2 are different instruments`,
    );
  }
  if (aw.familiesMin !== bw.familiesMin || aw.familiesMax !== bw.familiesMax) {
    throw new IncomparableMeasurementError(
      `different observed family width (${aw.familiesMin}-${aw.familiesMax} vs ${bw.familiesMin}-${bw.familiesMax}) — ` +
        `the quorum is a different size, so the veto behaviour is a different instrument`,
    );
  }
  if (
    aw.decisionRequiresQuorum !== bw.decisionRequiresQuorum ||
    aw.penaltyRequiresQuorum !== bw.penaltyRequiresQuorum
  ) {
    throw new IncomparableMeasurementError('different quorum gating — not the same instrument');
  }
}

/**
 * A historical number we choose to keep quoting but cannot attribute. Deliberately NOT a
 * `RuledMeasurement`: it can be printed, and it cannot be recorded or compared.
 */
export interface UnattributedNumber {
  metric: string;
  value: number;
  /** Where the number was quoted (a doc, a report, a table) — provenance of the QUOTE, not the run. */
  quotedIn: string;
  /** What is known and what could not be established. */
  note: string;
}

/** Render an unattributed historical number so it can never be mistaken for a measurement. */
export function formatUnattributed(n: UnattributedNumber): string {
  return `${formatMeasurement(n.metric, n.value, UNATTRIBUTED)} [quoted in: ${n.quotedIn}; ${n.note}]`;
}

/** Re-exported for callers building ruler strings from a manifest alone. */
export { describeCorpus, shortHash };
