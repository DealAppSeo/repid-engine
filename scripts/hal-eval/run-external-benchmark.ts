/**
 * GA3 external-benchmark runner (CC3 wiring). Runs HAL's REAL decision path against a recognized
 * hallucination/fact-verification benchmark and reports a confusion matrix + F1.
 *
 *   npm run build && node dist/scripts/hal-eval/run-external-benchmark.js \
 *     --dataset halueval --file ./data/halueval_qa.jsonl --limit 350 [--gate verdict-driven] [--persist]
 *   node ... --dataset fever --file ./data/fever_dev.jsonl --limit 350
 *
 * Requires the same free-tier provider keys the internal harness uses (GROQ/GEMINI/+ a third
 * family via env) — the family-diverse quorum, no funding. Writes a JSON report (summary + every
 * sample with provider+model strings) and, with --persist, per-sample rows to hal_benchmark_results.
 *
 * --gate verdict-driven sets HAL_VERDICT_DRIVEN_VETO=true for this run (CC1) so GA can compare
 * baseline vs gated. HAL_CATEGORY_SOFT_VETO is left OFF (W6).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import crypto from 'crypto';
import { db } from '../../src/db';
import { halService } from '../../src/hal/service';
import {
  normalizeHaluEval, normalizeFever, scoreBenchmark,
  type BenchmarkItem, type HalEvalLike,
} from '../../src/hal/benchmark';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? 'true' : fallback;
}

async function main() {
  const dataset = (arg('dataset') ?? '').toLowerCase();
  const file = arg('file');
  const limit = Number(arg('limit') ?? '0') || Infinity;
  const persist = !!arg('persist');
  if (dataset === 'verdict-driven' || arg('gate') === 'verdict-driven') {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
  }
  if (!['halueval', 'fever'].includes(dataset) || !file) {
    console.error('usage: --dataset halueval|fever --file <path.jsonl> [--limit N] [--gate verdict-driven] [--persist]');
    process.exit(2);
  }

  const runId = crypto.randomUUID();
  const gate = process.env.HAL_VERDICT_DRIVEN_VETO === 'true' ? 'verdict-driven' : 'baseline';
  console.log(`[bench] dataset=${dataset} file=${file} gate=${gate} run_id=${runId}`);

  // 1. Ingest JSONL -> normalized items.
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let items: BenchmarkItem[] = [];
  let dropped = 0;
  lines.forEach((line, idx) => {
    let rec: any;
    try { rec = JSON.parse(line); } catch { dropped++; return; }
    const norm = dataset === 'halueval' ? normalizeHaluEval(rec, idx) : normalizeFever(rec, idx);
    if (norm.length === 0) dropped++;
    items.push(...norm);
  });
  if (items.length > limit) items = items.slice(0, limit);
  console.log(`[bench] ingested ${items.length} items (${dropped} records dropped/unrecognized/NEI)`);

  // 2. Real HAL decision path. Context (HaluEval question/knowledge) is folded into the deliverable
  //    so HAL judges the claim with its context, without changing HAL's own code path.
  const evaluate = async (text: string, context?: string): Promise<HalEvalLike> => {
    const deliverable = context ? `Context: ${context}\nStatement: ${text}` : text;
    const r = await halService.evaluate({ text: deliverable, strictness: 2 });
    return { decision: r.decision as HalEvalLike['decision'], hal_score: r.hal_score, signals: r.signals as any };
  };

  let done = 0;
  const summary = await scoreBenchmark(items, evaluate, {
    onSample: (s) => {
      done++;
      if (done % 25 === 0 || done === items.length) process.stdout.write(`\r[bench] ${done}/${items.length}`);
      if (persist) {
        void db.from('hal_benchmark_results').insert({
          provider: s.providers ?? 'quorum', model: s.models ?? 'unknown',
          test_type: `${dataset}:${gate}`, question: s.context?.slice(0, 1000) ?? null,
          response: s.statement.slice(0, 2000), passed: s.correct,
          failure_type: s.correct ? null : (s.predictedHallucination ? 'false_positive' : 'false_negative'),
          hal_would_catch: s.predictedHallucination, tester: `ext-bench:${runId}`,
          notes: `gold_hallucination=${s.goldHallucination} hal_score=${s.halScore.toFixed(3)} decision=${s.decision}`,
        }).then(() => {}, (e: any) => console.warn('[bench] persist row failed:', e?.message));
      }
    },
  });
  process.stdout.write('\n');

  // 3. Report.
  const { tp, fp, fn, tn, precision, recall, f1, accuracy, n } = summary;
  console.log(`\n=== ${dataset} (${gate}) — N=${n} ===`);
  console.log(`TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} F1=${f1.toFixed(3)} acc=${accuracy.toFixed(3)}`);
  const reportPath = `./hal-bench-${dataset}-${gate}-${runId.slice(0, 8)}.json`;
  writeFileSync(reportPath, JSON.stringify({
    run_id: runId, dataset, gate, harness: 'ext-bench-v1', file,
    metrics: { n, tp, fp, fn, tn, precision, recall, f1, accuracy },
    samples: summary.samples,
  }, null, 2));
  console.log(`[bench] report written: ${reportPath} (hand to GA for GA4)`);
  process.exit(0);
}

main().catch((e) => { console.error('[bench] fatal:', e); process.exit(1); });
