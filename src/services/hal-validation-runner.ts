import { db } from '../db';
import { halService } from '../hal/service';
import { buildFactCheckProviders } from '../hal/fact-check';
import {
  DEFAULT_RULER_ID,
  HalCaseRow,
  RuledReport,
  caseFamilies,
  formatDelta,
  harnessWidth,
  keyed,
  loadRulerSelection,
  ruledReport,
  rulerKey,
} from '../hal/sealed-ruler';
import {
  IncomparableMeasurementError,
  RuledMeasurement,
  formatStoredMeasurement,
  rulerFaults,
  serializeRuler,
} from '../hal/measurement-ruler';
import crypto from 'crypto';

/**
 * 2.0.0 (2026-10-16): measures a named ruler (default hal-sealed-v1), never the whole readable table.
 * The summary row's harness_version carries `<version>|<rulerKey>`, so a later run can find a
 * comparable predecessor and nothing else. The 1.0.0 regression check compared against the previous
 * row whatever its corpus, plus a hard-coded 0.6154 "Gemini one-off" baseline with no ruler; both
 * were cross-ruler deltas and are gone.
 */
const HARNESS_VERSION = '2.0.0';

interface CaseRow extends HalCaseRow {
  category?: string | null;
  difficulty?: string | null;
}

export interface ValidationRun {
  runId: string;
  report: RuledReport;
}

function envTrue(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase());
}

/**
 * HAL_PERSIST_RULER (default OFF) — shadow ruler persistence for hal_validation_summaries.
 *
 * OFF: byte-identical to before this flag — the summary row carries no `ruler`, and the regression
 * read selects the same columns it always did.
 * ON (requires the `ruler jsonb` column from
 * supabase/migrations/20261102150000_hal_validation_summaries_ruler.sql, which the owner applies):
 * the run's MeasurementRuler is serialized into `ruler`, an UNRULED summary is REFUSED (never
 * written), and the regression read cites each stored F1 with its ruler — UNATTRIBUTED for a
 * historical row whose ruler was never recorded.
 *
 * Inert until the owner applies the migration AND sets HAL_PERSIST_RULER.
 */
function persistRulerEnabled(): boolean {
  return envTrue('HAL_PERSIST_RULER');
}

/** Thrown when HAL_PERSIST_RULER is on and the summary to persist carries no usable ruler. */
export class UnruledSummaryError extends Error {
  readonly faults: string[];
  constructor(faults: string[]) {
    super(
      `[HAL-Validation-Harness] refusing to persist an UNRULED summary — an accuracy number without ` +
        `its ruler is not a measurement and must not be recorded. Missing or invalid: ${faults.join(', ')}.`,
    );
    this.name = 'UnruledSummaryError';
    this.faults = faults;
  }
}

/**
 * Build the hal_validation_summaries insert payload from a ruled measurement.
 *
 * With persistRuler=false the row is exactly what this harness has always written (no `ruler` key).
 * With persistRuler=true the measurement's ruler is serialized into `ruler`; a measurement that does
 * not carry a usable ruler is REFUSED (throws UnruledSummaryError) rather than recorded — the
 * `rulerStatus: 'UNRULED'` condition the measurement modules document, enforced at the write.
 */
export function buildSummaryRow(args: {
  runId: string;
  measurement: RuledMeasurement;
  byCategory: Record<string, unknown>;
  byDifficulty: Record<string, unknown>;
  harnessTag: string;
  persistRuler: boolean;
}): Record<string, unknown> {
  const m = args.measurement;
  const row: Record<string, unknown> = {
    run_id: args.runId,
    total_cases: m.matrix.tp + m.matrix.fp + m.matrix.fn + m.matrix.tn,
    correct_cases: m.matrix.tp + m.matrix.tn,
    accuracy: m.metrics.accuracy,
    precision_score: m.metrics.precision,
    recall_score: m.metrics.recall,
    f1_score: m.metrics.f1,
    false_positives: m.matrix.fp,
    false_negatives: m.matrix.fn,
    true_positives: m.matrix.tp,
    true_negatives: m.matrix.tn,
    by_category: args.byCategory,
    by_difficulty: args.byDifficulty,
    harness_version: args.harnessTag,
  };
  if (!args.persistRuler) return row;
  const faults = rulerFaults(m.ruler);
  if (faults.length > 0) throw new UnruledSummaryError(faults);
  row.ruler = serializeRuler(m.ruler);
  return row;
}

/** jsonb-friendly slice: matrix + metrics + the corpus it was taken on. */
function sliceJson(m: RuledMeasurement) {
  return { corpus: `${m.ruler.corpus.corpusId}@${m.ruler.corpus.contentHash}`, n: m.ruler.corpus.caseCount, ...m.matrix, ...m.metrics };
}

export async function runValidationHarness(
  strictness: 1 | 2 = 1,
  opts: { ruler?: string } = {},
): Promise<ValidationRun> {
  const rulerId = opts.ruler ?? DEFAULT_RULER_ID;
  console.log(`[HAL-Validation-Harness] Starting validation run (strictness: ${strictness}, ruler: ${rulerId})...`);
  const runId = crypto.randomUUID();

  // 1. The ruler's population, computed at runtime from the DB. Refuses if the table no longer
  //    reproduces the ruler's pin.
  const sel = await loadRulerSelection<CaseRow>(db, rulerId, ['category', 'difficulty']);
  console.log(`Loaded ${sel.rows.length} cases of ${rulerId}@${sel.manifest.contentHash}.`);

  const providers = buildFactCheckProviders();
  const familiesConfigured = new Set(providers.map((p) => p.family ?? p.name)).size;
  const runsToInsert: any[] = [];
  const scored: { id: string; predictedHallucination: boolean }[] = [];
  const perCaseFamilies: number[] = [];

  // 2. Blindly score each case (HAL only gets prompt_text). The gold label is the selection's.
  for (const [i, tc] of sel.rows.entries()) {
    if (strictness === 2 && i > 0) await new Promise((resolve) => setTimeout(resolve, 800));

    const start = Date.now();
    const halRes = await halService.evaluate({ text: tc.prompt_text, strictness });
    const latency = Date.now() - start;

    const predicted = halRes.decision === 'vetoed';
    scored.push({ id: String(tc.id), predictedHallucination: predicted });
    perCaseFamilies.push(caseFamilies(strictness, halRes.signals));

    const activeProviders =
      strictness === 2 && Array.isArray(halRes.provider_responses)
        ? halRes.provider_responses.filter((pr: any) => pr.verdict !== 'ERROR' && pr.counted !== false).map((pr: any) => pr.provider)
        : [];
    const activeModels = activeProviders.map((name) => providers.find((p) => p.name === name)?.model ?? 'unknown');

    runsToInsert.push({
      run_id: runId,
      test_case_id: tc.id,
      hal_decision: halRes.decision,
      hal_score: halRes.hal_score,
      hal_signals: halRes.signals,
      correct: predicted === tc.expected_hallucination,
      latency_ms: latency,
      model: activeModels.length > 0 ? activeModels.join(',') : String(halRes.signals?.model || 'local-extractor'),
      provider: activeProviders.length > 0 ? activeProviders.join(',') : String(halRes.signals?.provider || 'local-extractor'),
      harness_version: HARNESS_VERSION,
    });
  }

  const { error: insErr } = await db.from('hal_validation_runs').insert(runsToInsert);
  if (insErr) console.error(`[HAL-Validation-Harness] Failed to write runs:`, insErr.message);

  // 3. Ruled metrics: overall, public-benchmark vs internal, and per category / difficulty.
  const width = harnessWidth({
    strictness,
    familiesConfigured,
    perCaseFamilies,
    decisionRequiresQuorum: envTrue('HAL_DECISION_REQUIRES_QUORUM'),
    penaltyRequiresQuorum: envTrue('HAL_PENALTY_REQUIRES_QUORUM'),
  });
  const report = ruledReport(sel, scored, width, {
    breakdowns: { category: (r) => r.category, difficulty: (r) => r.difficulty },
  });
  const m = report.overall;
  const tag = `${HARNESS_VERSION}|${rulerKey(m.ruler)}`;
  const slices = (name: string) =>
    Object.fromEntries(Object.entries(report.byBreakdown[name] ?? {}).map(([k, v]) => [k, sliceJson(v)]));

  // 4. Save to summaries table. HAL_PERSIST_RULER off = the historical payload, unchanged.
  const persistRuler = persistRulerEnabled();
  const { error: sumErr } = await db.from('hal_validation_summaries').insert(
    buildSummaryRow({
      runId,
      measurement: m,
      byCategory: slices('category'),
      byDifficulty: slices('difficulty'),
      harnessTag: tag,
      persistRuler,
    }),
  );
  if (sumErr) {
    console.error(`[HAL-Validation-Harness] Failed to write summary (ruler tag is ${tag.length} chars):`, sumErr.message);
  }

  // 5. Regression check against the latest earlier run on the SAME ruler only.
  await checkRegression(report, tag, persistRuler);

  return { runId, report };
}

async function checkRegression(report: RuledReport, tag: string, persistRuler: boolean): Promise<void> {
  // Select the stored ruler only when persistence is on (and so the column exists); OFF reads the
  // exact columns it always has, so the behaviour is unchanged. The select strings stay LITERAL in
  // each branch — supabase-js parses them at the type level and a dynamic string loses the row type.
  // [0] = this run, [1] = the previous run on this ruler.
  const { data, error } = persistRuler
    ? await db
        .from('hal_validation_summaries')
        .select('f1_score, harness_version, ruler')
        .eq('harness_version', tag)
        .order('run_at', { ascending: false })
        .limit(2)
    : await db
        .from('hal_validation_summaries')
        .select('f1_score, harness_version')
        .eq('harness_version', tag)
        .order('run_at', { ascending: false })
        .limit(2);

  console.log(`\n=== REGRESSION CHECK ===`);
  const prev = !error && data && data.length > 1 ? data[1] : undefined;
  if (!prev) {
    console.log(`No earlier run on ${rulerKey(report.overall.ruler)}; no delta (earlier F1s are on other rulers).`);
  } else {
    try {
      const prevF1 = prev.f1_score === null ? null : Number(prev.f1_score);
      // Read path: a stored F1 is quoted only through its ruler. A row whose ruler was never
      // recorded (any row before HAL_PERSIST_RULER: ruler = null) reads UNATTRIBUTED, never trended.
      if (persistRuler) {
        console.log(`Previous run: ${formatStoredMeasurement('f1', prevF1, (prev as { ruler?: unknown }).ruler ?? null)}`);
      }
      const prevKey = String(prev.harness_version).slice(HARNESS_VERSION.length + 1);
      console.log(formatDelta('f1', keyed(report.overall), { value: prevF1, ruler: prevKey }));
      const cur = report.overall.metrics.f1;
      if (cur !== null && prevF1 !== null && cur < prevF1) console.warn(`[WARNING] REGRESSION on the same ruler.`);
    } catch (e) {
      if (!(e instanceof IncomparableMeasurementError)) throw e;
      console.log(`Delta refused: ${e.message}`);
    }
  }
  console.log(`========================\n`);
}
