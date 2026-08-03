/**
 * HAL external-benchmark ingestion + scoring (CC3, 2026-06-08).
 *
 * Runs HAL's REAL decision path (cross-provider fact-check quorum, strictness 2) against a
 * recognized hallucination/fact-verification benchmark and computes a confusion matrix + F1.
 * HAL is a DETECTOR (judges a claim TRUE/FALSE), so the benchmarks are detection/verification
 * sets — HaluEval (primary) and FEVER (secondary). NOT TruthfulQA (that scores a generator).
 *
 * Positive class = HALLUCINATION / REFUTED. predicted-positive = HAL decision 'vetoed'
 * ('flagged'/'clean' = not-hallucination). With the verdict-driven gate (CC1,
 * HAL_VERDICT_DRIVEN_VETO) a veto requires a cross-provider FALSE quorum.
 *
 * Pure ingestion + mapping here (no network); the caller supplies an `evaluate` fn (the real
 * halService.evaluate) so this is unit-testable without provider keys. GA runs it with the
 * free-tier family-diverse quorum in env (GA3).
 *
 * --- HARNESS CONTRACT for GA ---
 *   normalizeHaluEval(line)  parses one HaluEval JSONL record -> BenchmarkItem[]
 *   normalizeFever(line)     parses one FEVER JSONL record    -> BenchmarkItem[]
 *   scoreBenchmark(items, evaluate, opts) -> BenchmarkSummary (TP/FP/FN/TN, P/R/F1/acc + samples)
 * GA wires these in scripts/hal-eval/run-external-benchmark.ts (provided) and points --file at
 * the downloaded dataset. Provider+model strings + run_id + dataset version are logged for repro.
 */

import {
  MeasurementRuler,
  RuledMeasurement,
  recordMeasurement,
} from './measurement-ruler';
import { CorpusCase, buildCorpusManifest, CorpusManifest } from './corpus-manifest';

export interface BenchmarkItem {
  /** stable id for the sample (dataset id + which answer, for HaluEval's right/hallucinated split). */
  id: string;
  dataset: 'halueval' | 'fever';
  /** the statement HAL judges (an answer or a claim). */
  statement: string;
  /** optional context (question/knowledge for HaluEval) — improves the fact-check prompt. */
  context?: string;
  /** gold label: true = hallucination / REFUTED (the positive class). */
  goldHallucination: boolean;
}

export interface BenchmarkSampleResult extends BenchmarkItem {
  predictedHallucination: boolean; // decision === 'vetoed'
  decision: 'vetoed' | 'flagged' | 'clean';
  halScore: number;
  correct: boolean;
  providers?: string;
  models?: string;
}

export interface BenchmarkSummary {
  dataset: string;
  n: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number; recall: number; f1: number; accuracy: number;
  samples: BenchmarkSampleResult[];
  /**
   * Whether this summary's numbers carry the ruler they were taken with.
   *
   * 'UNRULED' means the caller did not supply a `ruler`, so `f1`/`precision`/`recall` here describe an
   * unidentified population at an unidentified configuration — the exact condition that made HAL's
   * 0.34 / 0.74 / 0.886 / 0.890 mutually incomparable. An UNRULED summary must not be persisted,
   * published, or trended; `recordMeasurement` will refuse it.
   */
  rulerStatus: 'ruled' | 'UNRULED';
  /**
   * The ruled measurement, present only when a ruler was supplied. Carries the canonical citation
   * string ("F1 = x on corpus <id>@<hash> at N families, strictness s").
   */
  ruled?: RuledMeasurement;
}

/** Minimal shape of the HAL evaluation we depend on (halService.evaluate's result). */
export interface HalEvalLike {
  decision: 'vetoed' | 'flagged' | 'clean';
  hal_score: number;
  signals?: Record<string, unknown>;
}
export type EvaluateFn = (text: string, context?: string) => Promise<HalEvalLike>;

/**
 * HaluEval records come in a few subset shapes. We support the common ones:
 *  - QA:      { knowledge?, question, right_answer, hallucinated_answer }  -> 2 items
 *  - dialogue:{ knowledge?, dialogue_history, right_response, hallucinated_response } -> 2 items
 *  - general: { user_query, chatgpt_response, hallucination: "yes"|"no" } -> 1 item
 */
export function normalizeHaluEval(rec: any, idx: number): BenchmarkItem[] {
  const ctxParts = [rec.knowledge, rec.question, rec.dialogue_history, rec.user_query].filter(Boolean);
  const context = ctxParts.length ? String(ctxParts.join(' \n')).slice(0, 2000) : undefined;
  const right = rec.right_answer ?? rec.right_response;
  const wrong = rec.hallucinated_answer ?? rec.hallucinated_response;
  if (right != null && wrong != null) {
    return [
      { id: `halueval-${idx}-right`, dataset: 'halueval', statement: String(right), context, goldHallucination: false },
      { id: `halueval-${idx}-hallu`, dataset: 'halueval', statement: String(wrong), context, goldHallucination: true },
    ];
  }
  // general subset: a single response with an explicit yes/no hallucination label.
  if (rec.chatgpt_response != null && rec.hallucination != null) {
    const gold = String(rec.hallucination).trim().toLowerCase() === 'yes';
    return [{ id: `halueval-${idx}`, dataset: 'halueval', statement: String(rec.chatgpt_response), context, goldHallucination: gold }];
  }
  return []; // unrecognized record — skip (logged by the runner)
}

/** FEVER: { claim, label: "SUPPORTS"|"REFUTES"|"NOT ENOUGH INFO" }. NEI is dropped (no truth label). */
export function normalizeFever(rec: any, idx: number): BenchmarkItem[] {
  const claim = rec.claim;
  const label = String(rec.label ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (claim == null) return [];
  if (label === 'SUPPORTS') return [{ id: `fever-${idx}`, dataset: 'fever', statement: String(claim), goldHallucination: false }];
  if (label === 'REFUTES') return [{ id: `fever-${idx}`, dataset: 'fever', statement: String(claim), goldHallucination: true }];
  return []; // NOT ENOUGH INFO — no gold truth value, excluded (counted as dropped by the runner)
}

/**
 * Turn benchmark items into corpus cases, so a run can mint the manifest that identifies exactly the
 * population it scored. Order is preserved — the hash is order-sensitive by design.
 */
export function itemsToCorpusCases(items: readonly BenchmarkItem[]): CorpusCase[] {
  return items.map((it) => ({
    id: it.id,
    text: it.statement,
    expectedHallucination: it.goldHallucination,
    ...(it.context === undefined ? {} : { context: it.context }),
  }));
}

/**
 * Build the corpus manifest for a set of benchmark items. Use this to produce the `corpus` half of a
 * ruler for the items you are actually about to score (post-slicing, post-limit) rather than for the
 * dataset you nominally loaded — a `--limit 1000` run measures 1000 cases, not the whole file.
 */
export function manifestForItems(corpusId: string, items: readonly BenchmarkItem[]): CorpusManifest {
  const dataset = items[0]?.dataset ?? 'unknown';
  return buildCorpusManifest({
    corpusId,
    cases: itemsToCorpusCases(items),
    sources: [{ source: String(dataset), caseCount: items.length }],
  });
}

/**
 * Run the (real) HAL evaluate over items and compute the confusion matrix + F1.
 *
 * Supplying `opts.ruler` is what makes the resulting numbers quotable: it attaches the corpus identity
 * and configuration width, and the returned summary gains `ruled` (with its citation string) and
 * `rulerStatus: 'ruled'`. Omitting it yields `rulerStatus: 'UNRULED'`, and any attempt to record or
 * compare that summary's metrics is refused downstream. Prefer `scoreBenchmarkRuled`, which makes the
 * ruler a required argument rather than an easily-forgotten option.
 */
export async function scoreBenchmark(
  items: BenchmarkItem[],
  evaluate: EvaluateFn,
  opts: { onSample?: (r: BenchmarkSampleResult) => void; ruler?: MeasurementRuler } = {},
): Promise<BenchmarkSummary> {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const samples: BenchmarkSampleResult[] = [];
  const dataset = items[0]?.dataset ?? 'unknown';
  for (const it of items) {
    const ev = await evaluate(it.statement, it.context);
    const predicted = ev.decision === 'vetoed';
    const correct = predicted === it.goldHallucination;
    if (predicted && it.goldHallucination) tp++;
    else if (predicted && !it.goldHallucination) fp++;
    else if (!predicted && it.goldHallucination) fn++;
    else tn++;
    const sig = (ev.signals ?? {}) as any;
    const r: BenchmarkSampleResult = {
      ...it,
      predictedHallucination: predicted,
      decision: ev.decision,
      halScore: ev.hal_score,
      correct,
      providers: Array.isArray(sig.provider_responses) ? sig.provider_responses.map((p: any) => p.provider).join(',') : undefined,
      models: Array.isArray(sig.provider_responses) ? sig.provider_responses.map((p: any) => p.model ?? 'unknown').join(',') : undefined,
    };
    samples.push(r);
    opts.onSample?.(r);
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const accuracy = (tp + tn) / (items.length || 1);

  // Attach the ruler when one was supplied. `recordMeasurement` validates it and throws if it is
  // incomplete — a bad ruler fails here rather than producing a number that looks authoritative.
  const ruled = opts.ruler
    ? recordMeasurement({ matrix: { tp, fp, fn, tn }, ruler: opts.ruler })
    : undefined;

  return {
    dataset: String(dataset),
    n: items.length,
    tp, fp, fn, tn,
    precision, recall, f1, accuracy,
    samples,
    rulerStatus: ruled ? 'ruled' : 'UNRULED',
    ...(ruled ? { ruled } : {}),
  };
}

/**
 * The sanctioned measurement entry point: identical to `scoreBenchmark` except the ruler is REQUIRED.
 *
 * `scoreBenchmark` keeps its optional-ruler signature so existing callers continue to compile, but new
 * measurement code should use this one — a required argument is the difference between a rule and a
 * suggestion, and the suggestion is what left every historical F1 unattributable.
 *
 * The returned summary always has `rulerStatus === 'ruled'` and a populated `ruled.citation`.
 */
export async function scoreBenchmarkRuled(
  items: BenchmarkItem[],
  evaluate: EvaluateFn,
  opts: { ruler: MeasurementRuler; onSample?: (r: BenchmarkSampleResult) => void },
): Promise<BenchmarkSummary & { ruled: RuledMeasurement }> {
  const summary = await scoreBenchmark(items, evaluate, opts);
  // Unreachable unless scoreBenchmark's contract is broken; asserted so a future refactor cannot
  // silently downgrade this path to UNRULED.
  if (!summary.ruled) {
    throw new Error('[hal-benchmark] scoreBenchmarkRuled produced an UNRULED summary — contract violated');
  }
  return summary as BenchmarkSummary & { ruled: RuledMeasurement };
}
