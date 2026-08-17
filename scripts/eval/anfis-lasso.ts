/**
 * anfis-lasso.ts — LASSO-style sparse signal selection on the labeled canary corpus.
 *
 * PURPOSE (measurement, NOT cutover)
 * ----------------------------------
 * Derive an EVIDENCE-BASED, interpretable answer to: "which signals actually predict a provider
 * getting a claim RIGHT?" so we know which ANFIS inputs deserve weight — BEFORE ever trusting ANFIS
 * to route. This is the directional weight-prior step; it does NOT wire anything into live routing.
 *
 * DATA
 * ----
 * Input: the canary F1 raw results (reports/2026-07-DD/canary-f1-raw-*.json). Each of the ~50 labeled
 * claims carries per-provider `verdicts[]` with { provider, verdict, confidence, latency_ms, error? }.
 * We build ONE training row per (claim, provider) verdict:
 *   target y   = 1 if the provider's verdict matched the ground-truth label, else 0 (ERROR counts as 0)
 *   features X = interpretable signals a router could key on (see FEATURES below)
 *
 * METHOD (lightweight, no heavy deps)
 * -----------------------------------
 * L1-penalized logistic regression via cyclic coordinate descent with soft-thresholding on
 * standardized features. Sparse by construction: signals whose standardized coefficient is driven to
 * ~0 are "not selected". We sweep a small lambda path and report the coefficients at a moderate lambda
 * plus the full ranking by |coefficient|. Interpretable + cheap; runs in-process, no ML libs.
 *
 * HONESTY
 * -------
 * Small N (~50 claims × up to 6 providers ≈ a few hundred verdict rows, minus ERRORs). These are a
 * DIRECTIONAL PRIOR for ANFIS input weights, NOT a trained production model. The report states N and
 * the class balance so nobody over-reads it.
 *
 * SECOND INPUT PATH — the joined routing corpus (added 2026-08-17)
 * ----------------------------------------------------------------
 * The canary corpus above answers "which signals predict a provider getting a CLAIM right".
 * It cannot answer "which ROUTING-DECISION features predict the call succeeding", because it
 * contains no routing decisions. That second corpus now has a home: decision-time features
 * are written to `routing_decision_records` and joined to `llm_call_log` on
 * (call_id, provider) — see src/decisioning/routing-record-persist.ts.
 *
 * `--joined <path.json>` fits that corpus instead. **The fitting maths is untouched** —
 * `fitLassoLogistic`, `standardize` and `softThreshold` are byte-identical on both paths;
 * only the (X, y) builder and the feature labels differ. Featurisation lives in
 * src/decisioning/routing-corpus.ts so it is unit-testable without a database.
 *
 * USAGE
 *   npx ts-node scripts/eval/anfis-lasso.ts [path-to-canary-f1-raw.json]
 *   npx ts-node scripts/eval/anfis-lasso.ts --joined <routing-corpus.json>
 * If no path is given it auto-discovers the newest canary-f1-raw-*.json under reports/.
 * Produce the joined corpus with scripts/eval/fetch-routing-corpus.ts.
 * Writes a markdown report to reports/<today>/ANFIS_LASSO_SIGNALS.md (path echoed to stdout).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildRoutingCorpus,
  type JoinedRoutingRow,
} from '../../src/decisioning/routing-corpus';

// ---------------------------------------------------------------------------
// Types describing the canary-f1 raw JSON we consume (only the fields we use).
// ---------------------------------------------------------------------------
interface Verdict {
  provider: string;
  verdict: string; // 'TRUE' | 'FALSE' | 'ERROR' | ...
  confidence: number; // 0..100 self-reported
  latency_ms?: number;
  error?: string;
}
interface ResultRow {
  claim: string;
  label: string; // ground truth 'TRUE' | 'FALSE'
  domain: string;
  difficulty: string; // 'easy' | 'medium' | 'hard'
  verdicts: Verdict[];
}
interface CanaryF1Raw {
  generated_at: string;
  corpus_size: number;
  overall?: { f1?: number; accuracy?: number };
  results: ResultRow[];
}

// ---------------------------------------------------------------------------
// FEATURES — interpretable signals that could predict a correct provider verdict.
// Each maps conceptually onto an ANFIS router input (accuracy / calibration / latency / cost).
// ---------------------------------------------------------------------------
const FEATURE_NAMES = [
  'confidence',       // provider self-reported confidence (calibration signal)
  'is_error',         // provider returned an ERROR / 429 (availability signal)
  'latency_ms',       // response latency (latency signal)
  'difficulty',       // claim difficulty 0=easy,0.5=medium,1=hard (task-hardness signal)
  'category',         // domain category numeric (see domainToCategory)
  'prov_groq',        // per-provider indicators (which provider is intrinsically more reliable)
  'prov_cerebras',
  'prov_deepseek',
  'prov_gemini',
  'prov_mistral',
  'prov_openrouter',
] as const;

type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * Map a domain string to a coarse numeric category, mirroring the spirit of anfis-router.ts's
 * featurizePrompt cat signal (hard-fact/code high, opinion/creative low, else mid).
 */
function domainToCategory(domain: string): number {
  const d = (domain || '').toLowerCase();
  if (/physics|chemistry|biology|mathematics|medicine|astronomy|geology/.test(d)) return 0.9; // hard science
  if (/history|geography|demographics|current_facts|history_of_science/.test(d)) return 0.6; // factual
  if (/art|literature|misconception/.test(d)) return 0.4; // softer / trickier
  return 0.5;
}

function difficultyToNum(diff: string): number {
  const d = (diff || '').toLowerCase();
  if (d === 'easy') return 0;
  if (d === 'medium') return 0.5;
  if (d === 'hard') return 1;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Build the (X, y) training matrix from the raw results.
// ---------------------------------------------------------------------------
function buildDataset(raw: CanaryF1Raw): { X: number[][]; y: number[]; providerCounts: Record<string, number> } {
  const X: number[][] = [];
  const y: number[] = [];
  const providerCounts: Record<string, number> = {};

  for (const r of raw.results) {
    const label = (r.label || '').toUpperCase();
    const cat = domainToCategory(r.domain);
    const diff = difficultyToNum(r.difficulty);
    for (const v of r.verdicts || []) {
      const prov = v.provider;
      providerCounts[prov] = (providerCounts[prov] || 0) + 1;
      const isError = /error/i.test(v.verdict) || !!v.error ? 1 : 0;
      // Correct only if a real (non-error) verdict equals the ground-truth label.
      const correct = isError === 0 && (v.verdict || '').toUpperCase() === label ? 1 : 0;

      const row: number[] = [
        (Number(v.confidence) || 0) / 100, // confidence 0..1
        isError,
        Number(v.latency_ms) || 0,          // standardized later
        diff,
        cat,
        prov === 'groq' ? 1 : 0,
        prov === 'cerebras' ? 1 : 0,
        prov === 'deepseek' ? 1 : 0,
        prov === 'gemini' ? 1 : 0,
        prov === 'mistral' ? 1 : 0,
        prov === 'openrouter' ? 1 : 0,
      ];
      X.push(row);
      y.push(correct);
    }
  }
  return { X, y, providerCounts };
}

// ---------------------------------------------------------------------------
// Standardize features (zero mean, unit variance) so the L1 penalty is scale-fair.
// Returns standardized matrix + per-feature mean/std for interpretation.
// ---------------------------------------------------------------------------
function standardize(X: number[][]): { Z: number[][]; mean: number[]; std: number[] } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const mean = new Array(p).fill(0);
  const std = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i]![j]!;
    mean[j] = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const d = X[i]![j]! - mean[j];
      v += d * d;
    }
    std[j] = Math.sqrt(v / n) || 1; // guard against constant columns
  }
  const Z = X.map((row) => row.map((x, j) => (x - mean[j]!) / std[j]!));
  return { Z, mean, std };
}

// ---------------------------------------------------------------------------
// L1-penalized logistic regression via cyclic coordinate descent.
// Minimizes mean logistic loss + lambda * sum|beta_j| (intercept unpenalized).
// Hand-rolled proximal-gradient per coordinate — no external deps.
// ---------------------------------------------------------------------------
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}
function softThreshold(x: number, t: number): number {
  if (x > t) return x - t;
  if (x < -t) return x + t;
  return 0;
}

function fitLassoLogistic(
  Z: number[][],
  y: number[],
  lambda: number,
  opts: { maxIter?: number; lr?: number; tol?: number } = {}
): { beta: number[]; intercept: number } {
  const n = Z.length;
  const p = Z[0]?.length ?? 0;
  const maxIter = opts.maxIter ?? 500;
  const lr = opts.lr ?? 0.5;
  const tol = opts.tol ?? 1e-6;

  let beta = new Array(p).fill(0);
  let intercept = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // Predicted probabilities under current params.
    const eta = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let e = intercept;
      const zi = Z[i]!;
      for (let j = 0; j < p; j++) e += beta[j]! * zi[j]!;
      eta[i] = sigmoid(e);
    }
    // Gradient of mean logistic loss wrt each param (residual = p - y).
    let gInt = 0;
    for (let i = 0; i < n; i++) gInt += eta[i]! - y[i]!;
    gInt /= n;
    const newIntercept = intercept - lr * gInt; // intercept unpenalized

    const newBeta = beta.slice();
    let maxDelta = Math.abs(newIntercept - intercept);
    for (let j = 0; j < p; j++) {
      let g = 0;
      for (let i = 0; i < n; i++) g += (eta[i]! - y[i]!) * Z[i]![j]!;
      g /= n;
      // Gradient step then soft-threshold (proximal L1).
      const stepped = beta[j]! - lr * g;
      const updated = softThreshold(stepped, lr * lambda);
      maxDelta = Math.max(maxDelta, Math.abs(updated - beta[j]!));
      newBeta[j] = updated;
    }
    beta = newBeta;
    intercept = newIntercept;
    if (maxDelta < tol) break;
  }
  return { beta, intercept };
}

// ---------------------------------------------------------------------------
// Discovery: find newest canary-f1-raw-*.json under reports/ if no path given.
// ---------------------------------------------------------------------------
function findLatestRaw(repoRoot: string): string | null {
  const reportsDir = path.join(repoRoot, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const candidates: { file: string; mtime: number }[] = [];
  for (const day of fs.readdirSync(reportsDir)) {
    const dayDir = path.join(reportsDir, day);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const f of fs.readdirSync(dayDir)) {
      if (/canary-f1-raw.*\.json$/i.test(f)) {
        const full = path.join(dayDir, f);
        candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * What a corpus loader must hand back. `datasetLines` and `honestyLines` are the RULER —
 * a coefficient table without its corpus, row count and date is not a result.
 */
interface LoadedCorpus {
  X: number[][];
  y: number[];
  featureNames: readonly string[];
  providerCounts: Record<string, number>;
  title: string;
  /** Report filename. Distinct per corpus — one ruler per file. */
  outFile: string;
  whatThisIs: string[];
  datasetLines: string[];
  honestyLines: string[];
}

/** Input path 1 (unchanged): the labelled canary F1 corpus. */
function loadCanaryCorpus(repoRoot: string, argPath: string | undefined): LoadedCorpus {
  const rawPath = argPath || findLatestRaw(repoRoot);
  if (!rawPath || !fs.existsSync(rawPath)) {
    console.error('[anfis-lasso] no canary-f1-raw JSON found. Pass a path or generate one via scripts/eval/canary-f1.ts');
    process.exit(1);
  }
  console.log('[anfis-lasso] using raw results:', rawPath);
  const raw: CanaryF1Raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const { X, y, providerCounts } = buildDataset(raw);
  const n = X.length;
  const positives = y.reduce((a, b) => a + b, 0);
  return {
    X,
    y,
    featureNames: FEATURE_NAMES,
    providerCounts,
    title: '# ANFIS LASSO Signal Selection — canary corpus (measurement, not cutover)',
    outFile: 'ANFIS_LASSO_SIGNALS.md',
    whatThisIs: [
      'L1-penalized logistic regression (hand-rolled coordinate descent, no ML deps) over per-(claim,provider)',
      'verdicts from the labeled canary corpus. Target = did the provider get the claim RIGHT. The sparse',
      'coefficients tell us **which signals actually predict a correct verdict** — i.e. which ANFIS inputs',
      'deserve weight. This is a **directional prior**, not a trained model, and it is **not wired into live',
      'routing**. `ROUTER_STRICT_COST_ORDER` stays true (static cost-order in control).',
    ],
    datasetLines: [
      `Source raw results: \`${path.relative(repoRoot, rawPath)}\` (generated_at ${raw.generated_at})`,
      `- Claims: ${raw.results.length} · verdict rows (training examples): **${n}**`,
      `- Positive class (correct verdicts): ${positives} (${n ? ((positives / n) * 100).toFixed(1) : '0.0'}%)`,
      `- Corpus F1 (context, from raw): ${raw.overall?.f1 ?? 'n/a'} · accuracy ${raw.overall?.accuracy ?? 'n/a'}`,
      `- Verdicts per provider: ${Object.entries(providerCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    ],
    honestyLines: [
      `- **Small N (${n} verdict rows over ${raw.results.length} claims).** This is enough to see *directional*`,
      '  signal (which inputs matter, and their sign) but NOT enough to trust exact magnitudes or to justify a',
      '  routing cutover. Treat as a weight PRIOR for the ANFIS inputs.',
      '- Confidence is provider **self-reported** (calibration, not ground truth) — high weight on it should be',
      '  read with that caveat.',
      '- The canary corpus skews easy/factual; hard-domain behavior is under-sampled. Re-run as the corpus and',
      '  the shadow log (`anfis_routing_logs`) grow, then re-measure before any cutover.',
    ],
  };
}

/**
 * Input path 2 (new): the joined routing corpus — decision features from
 * `routing_decision_records` against the outcome label from `llm_call_log`, keyed on
 * (call_id, provider). Produce the file with scripts/eval/fetch-routing-corpus.ts.
 */
function loadJoinedCorpus(repoRoot: string, corpusPath: string | undefined): LoadedCorpus {
  if (!corpusPath || !fs.existsSync(corpusPath)) {
    console.error('[anfis-lasso] --joined needs a corpus JSON path. Produce one with:');
    console.error('  npx ts-node scripts/eval/fetch-routing-corpus.ts <out.json>');
    process.exit(1);
  }
  console.log('[anfis-lasso] using joined routing corpus:', corpusPath);
  const parsed = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const rows: JoinedRoutingRow[] = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
  const meta = Array.isArray(parsed) ? {} : (parsed.meta ?? {});
  const corpus = buildRoutingCorpus(rows);
  const n = corpus.X.length;
  const positives = corpus.y.reduce((a, b) => a + b, 0);
  return {
    X: corpus.X,
    y: corpus.y,
    featureNames: corpus.featureNames,
    providerCounts: corpus.providerCounts,
    title: '# LASSO on the joined routing corpus — decision features vs call outcome',
    outFile: 'ROUTING_CORPUS_LASSO_SIGNALS.md',
    whatThisIs: [
      'The SAME L1-penalized logistic regression, over a different corpus: one row per routing DECISION',
      '(`routing_decision_records`) joined to its OUTCOME (`llm_call_log.status`) on (call_id, provider).',
      'Target = did the call succeed. Every feature is knowable before the provider was called — latency and',
      'cost are outcomes and are deliberately excluded, so nothing here is a model of a decision that could',
      'not have been made. **Not wired into live routing.** `ROUTER_STRICT_COST_ORDER` stays default-strict',
      'and `ANFIS_ROUTING_MODE` stays default-shadow.',
    ],
    datasetLines: [
      `Source corpus: \`${path.relative(repoRoot, corpusPath)}\`` +
        (meta.fetched_at ? ` (fetched_at ${meta.fetched_at})` : ''),
      `- Joined rows supplied: ${corpus.rowsIn} · **dropped for having no outcome row: ${corpus.droppedUnlabelled}**`,
      `- Training rows (labelled): **${n}**`,
      `- Positive class (status='success'): ${positives} (${n ? ((positives / n) * 100).toFixed(1) : '0.0'}%)`,
      `- Rows per provider: ${Object.entries(corpus.providerCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
    ],
    honestyLines: [
      `- **N = ${n} labelled decisions.** A dropped row is an UNOBSERVED decision, not a failed one; ` +
        `${corpus.droppedUnlabelled} were dropped and are counted above rather than absorbed into the negatives.`,
      '- Features are decision-time only. `attempt` is a feature because the router already holds the exclusion',
      '  set it was handed; `latency_ms` and `cost_usd` are not, because they are measured after the call.',
      '- Provider identity is NOT a column here. The chain shape and cost classes are; a per-provider indicator',
      '  set would mostly re-encode the static cost order and swamp the shape signals.',
      '- This is a directional prior for which decision features carry signal. It is not a fitted production',
      '  weight and no production weight is refitted from it.',
    ],
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const argv = process.argv.slice(2);
  const joinedIdx = argv.indexOf('--joined');
  const loaded =
    joinedIdx >= 0
      ? loadJoinedCorpus(repoRoot, argv[joinedIdx + 1])
      : loadCanaryCorpus(repoRoot, argv[0]);

  const { X, y, featureNames } = loaded;
  const n = X.length;
  const positives = y.reduce((a, b) => a + b, 0);
  if (n < 10) {
    // FAIL LOUD, and name the ruler. "Too thin to fit" is a result; a fit on 9 rows is not.
    console.error(`[anfis-lasso] CORPUS TOO THIN — ${n} labelled rows, ${loaded.featureNames.length} features.`);
    console.error('[anfis-lasso] NOT CHECKED: no fit attempted. Collect more rows and re-run.');
    loaded.datasetLines.forEach((l) => console.error('  ' + l.replace(/^- /, '')));
    process.exit(1);
  }

  const { Z, mean, std } = standardize(X);

  // Lambda path (log-spaced, strong→weak penalty). The path IS the LASSO story: the order signals
  // enter (survive) as the penalty relaxes = their importance order.
  const lambdas = [0.2, 0.1, 0.05, 0.02, 0.01, 0.005];
  const fits = lambdas.map((lam) => ({ lambda: lam, ...fitLassoLogistic(Z, y, lam) }));

  // "Reported" fit for the headline table: the sparse-but-informative knee — the smallest lambda that
  // still keeps the model sparse (zeros ≥1 feature) yet retains a useful set (≥3 signals). This avoids
  // both the over-penalized end (only 1 signal survives) and the fully-dense end. Falls back to the
  // weakest-penalty fit if no lambda hits the window.
  const reported =
    fits.find((f) => {
      const nz = f.beta.filter((b) => Math.abs(b) > 1e-6).length;
      return nz >= 3 && nz < f.beta.length;
    }) ??
    [...fits].reverse().find((f) => f.beta.some((b) => Math.abs(b) < 1e-6)) ??
    fits[fits.length - 1]!;

  // Rank features by |standardized coefficient| at the reported lambda.
  const ranked = featureNames.map((name, j) => ({
    name,
    coef: reported.beta[j]!,
    absCoef: Math.abs(reported.beta[j]!),
    selected: Math.abs(reported.beta[j]!) > 1e-6,
    mean: mean[j]!,
    std: std[j]!,
  })).sort((a, b) => b.absCoef - a.absCoef);

  // Suggested ANFIS input-weight prior: normalize |coef| of the SELECTED signals to sum 1.
  const selectedSignals = ranked.filter((r) => r.selected);
  const totalAbs = selectedSignals.reduce((a, r) => a + r.absCoef, 0) || 1;
  const suggestedWeights = selectedSignals.map((r) => ({
    name: r.name,
    weight: Number((r.absCoef / totalAbs).toFixed(3)),
    direction: r.coef >= 0 ? '+' : '-',
  }));

  // ---- Write markdown report ----
  const outDir = path.join(repoRoot, 'reports', todayStr());
  fs.mkdirSync(outDir, { recursive: true });
  // Two corpora, two rulers, two files. Sharing one filename would let a routing-corpus
  // run silently replace a canary run's numbers under the same heading, and "did the
  // signal move?" would then have no answer. See LESSONS 8.
  const outPath = path.join(outDir, loaded.outFile);

  const md: string[] = [];
  md.push(loaded.title);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(loaded.datasetLines[0]!);
  md.push('');
  md.push('## What this is');
  loaded.whatThisIs.forEach((l) => md.push(l));
  md.push('');
  md.push('## Dataset');
  loaded.datasetLines.slice(1).forEach((l) => md.push(l));
  md.push('');
  md.push(`## Ranked signals (reported lambda = ${reported.lambda})`);
  md.push('Coefficients are on **standardized** features, so |coef| is comparable across signals.');
  md.push('A positive coefficient = the signal makes a correct verdict MORE likely; negative = less likely.');
  md.push('');
  md.push('| rank | signal | coef (std) | selected | direction |');
  md.push('|---|---|---|---|---|');
  ranked.forEach((r, i) => {
    md.push(
      `| ${i + 1} | \`${r.name}\` | ${r.coef.toFixed(4)} | ${r.selected ? 'YES' : 'no (→0)'} | ${
        r.coef >= 0 ? 'positive' : 'negative'
      } |`
    );
  });
  md.push('');
  md.push('## Suggested ANFIS input-weight prior (selected signals, |coef| normalized to sum 1)');
  md.push('These are a **prior** for the ANFIS input importances — a starting point to measure against, not');
  md.push('final weights. Sign tells you the direction the signal pushes provider-correctness.');
  md.push('');
  md.push('| signal | suggested weight | direction |');
  md.push('|---|---|---|');
  suggestedWeights.forEach((w) => md.push(`| \`${w.name}\` | ${w.weight} | ${w.direction} |`));
  md.push('');
  md.push('## Lambda path (sparsity vs lambda)');
  md.push('| lambda | # non-zero signals |');
  md.push('|---|---|');
  fits.forEach((f) => md.push(`| ${f.lambda} | ${f.beta.filter((b) => Math.abs(b) > 1e-6).length} |`));
  md.push('');
  md.push('## Coefficient path (entry order = importance order)');
  md.push('Standardized coefficient of each signal at each lambda (strong→weak penalty). The lambda at which');
  md.push('a signal first becomes non-zero tells you how strongly the data supports it — earlier = stronger.');
  md.push('');
  md.push(`| signal | ${lambdas.map((l) => `λ=${l}`).join(' | ')} |`);
  md.push(`|---|${lambdas.map(() => '---').join('|')}|`);
  featureNames.forEach((name, j) => {
    const cells = fits.map((f) => {
      const b = f.beta[j]!;
      return Math.abs(b) < 1e-6 ? '·' : b.toFixed(3);
    });
    md.push(`| \`${name}\` | ${cells.join(' | ')} |`);
  });
  md.push('');
  md.push('## Honesty note on trusting these weights');
  loaded.honestyLines.forEach((l) => md.push(l));
  md.push('');

  fs.writeFileSync(outPath, md.join('\n'), 'utf8');

  // ---- Console summary ----
  console.log(`\n[anfis-lasso] N=${n} rows, ${positives} positive (${((positives / n) * 100).toFixed(1)}%)`);
  console.log(`[anfis-lasso] reported lambda=${reported.lambda}`);
  console.log('[anfis-lasso] top signals by |coef|:');
  ranked.slice(0, 8).forEach((r, i) =>
    console.log(`  ${i + 1}. ${r.name.padEnd(14)} coef=${r.coef.toFixed(4)} ${r.selected ? '(selected)' : '(→0)'}`)
  );
  console.log(`[anfis-lasso] report written: ${path.relative(repoRoot, outPath)}`);
}

main();
