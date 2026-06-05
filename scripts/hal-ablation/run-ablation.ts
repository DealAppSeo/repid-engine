/**
 * S-HAL-ABLATION Phase 2 (HEADLINE) — does HAL beat a plain 3-LLM ensemble?
 *
 * Four scorers over the IDENTICAL corpus (data/corpus.json), free-tier providers only
 * (groq llama-3.1-8b-instant / cerebras zai-glm-4.7 / fireworks kimi-k2p5):
 *
 *   A   Plain 3-LLM majority vote          — count FALSE verdicts; no Comma, no confidence, no extractor.
 *   B0  HAL ensemble, Comma OFF            — factCheck mean provider-RISK (confidence-weighted), comma=1.
 *   B   HAL ensemble, Comma ON  (= HAL)    — B0 × Pythagorean Comma (531441/524288), clamped to 1.
 *   C   Production extractor (strictness 1)— the live blind score-event path.
 *
 * A and B/B0 share ONE factCheck call per item (3 provider calls), cached to disk so re-runs cost $0.
 * C is pure (no I/O). For each scorer: AUC (threshold-free), F1/precision/recall/veto-rate at a fixed
 * threshold, and separation (mean score on hallucinations − mean on correct). Positive class =
 * hallucination (gt_hallucination=true).
 *
 * Comma isolation: B vs B0 share the exact same ensemble scores; their only difference is the Comma
 * scalar. A constant multiply is rank-preserving, so AUC_B can only equal AUC_B0 (or fall, via the
 * clamp at 1.0) — never exceed it. That is the empirical test of whether the Comma adds discrimination.
 *
 * MEASURE-ONLY. Run: ts-node scripts/hal-ablation/run-ablation.ts   (LIMIT=6 for a smoke subset)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { factCheck, buildFactCheckProviders, factCheckOptsFromEnv, ProviderVerdict } from '../../src/hal/fact-check';
import { evaluate } from '../../src/hal/lib/evaluate';

const COMMA = 531441 / 524288; // Pythagorean Comma ≈ 1.013643
const DATA = path.join(__dirname, 'data');
const CACHE = path.join(__dirname, 'cache');
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

interface CorpusItem { id: string; text: string; gt_hallucination: boolean; category: string; source: string; }
interface CachedFC { hal_score: number; verdicts: ProviderVerdict[]; providers_used: number; agreement: number | null; decision: string; }

let callsMade = 0;

const CACHE_ONLY = process.env.CACHE_ONLY === '1';

async function getFactCheck(item: CorpusItem, providers: any[], opts: any): Promise<CachedFC | null> {
  const key = crypto.createHash('sha256').update(item.text).digest('hex').slice(0, 32);
  const cacheFile = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedFC;
  }
  if (CACHE_ONLY) return null; // no fresh calls — compute only over the cached quorum set
  const r = await factCheck(item.text, providers, opts);
  callsMade += providers.length;
  const cached: CachedFC = {
    hal_score: r.hal_score, verdicts: r.verdicts, providers_used: r.providers_used,
    agreement: r.agreement, decision: r.decision,
  };
  // Only cache a real quorum (>=2 providers). Degraded results (transient 429/outage) are NOT cached
  // so a re-run retries them instead of freezing a one-provider answer. Good results → $0 re-runs.
  if (r.providers_used >= 2) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
  }
  return cached;
}

/** Plain majority vote: fraction of non-error verdicts that say FALSE (UNCERTAIN counts 0.5). */
function plainMajorityScore(verdicts: ProviderVerdict[]): number | null {
  const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
  if (ok.length === 0) return null;
  let falseN = 0, uncertainN = 0;
  for (const v of ok) { if (v.verdict === 'FALSE') falseN++; else if (v.verdict === 'UNCERTAIN') uncertainN++; }
  return (falseN + 0.5 * uncertainN) / ok.length;
}

// ---- metrics ----
function aucROC(scores: number[], labels: boolean[]): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const rank = new Array<number>(n);
  let i = 0;
  while (i < n) { // tie-averaged ranks (1-based)
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]!] = avg;
    i = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let t = 0; t < n; t++) { if (labels[t]) { sumPos += rank[t]!; nPos++; } else nNeg++; }
  if (nPos === 0 || nNeg === 0) return NaN;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function confusionAt(scores: number[], labels: boolean[], thr: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i]! >= thr;
    if (labels[i]) pred ? tp++ : fn++; else pred ? fp++ : tn++;
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const veto_rate = (tp + fp) / (scores.length || 1);
  return { tp, fp, fn, tn, precision, recall, f1, veto_rate };
}

function separation(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return mean(pos) - mean(neg);
}

function summarize(name: string, scores: number[], labels: boolean[], thr: number) {
  const auc = aucROC(scores, labels);
  const c = confusionAt(scores, labels, thr);
  const sep = separation(scores, labels);
  return {
    scorer: name, n: scores.length, threshold: thr,
    auc: +auc.toFixed(4), f1: +c.f1.toFixed(4), precision: +c.precision.toFixed(4),
    recall: +c.recall.toFixed(4), veto_rate: +c.veto_rate.toFixed(4), separation: +sep.toFixed(4),
    tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn,
  };
}

(async () => {
  const corpus: CorpusItem[] = JSON.parse(fs.readFileSync(path.join(DATA, 'corpus.json'), 'utf8'));
  const items = corpus.slice(0, LIMIT);
  const providers = buildFactCheckProviders();
  const opts = factCheckOptsFromEnv();
  console.log(`[ablation] ${items.length} items · providers=${providers.map((p: any) => p.name).join(',')} · veto=${opts.vetoThreshold}`);
  if (!CACHE_ONLY && providers.length < 2) { console.error('[ablation] need >=2 providers; aborting'); process.exit(1); }

  const rows: any[] = [];
  let degraded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const fc = await getFactCheck(it, providers, opts);
    if (fc === null) continue; // CACHE_ONLY: item not yet cached, skip without calling
    const er = await evaluate(it.text, it.text, { domain: 'general', certainty: 0.8, strictness: 1 });
    const sA = plainMajorityScore(fc.verdicts);
    const quorum = fc.providers_used >= 2;
    if (!quorum) degraded++;
    rows.push({
      id: it.id, gt: it.gt_hallucination, source: it.source, providers_used: fc.providers_used, quorum,
      score_A: sA, score_B0: fc.hal_score, score_B: Math.min(1, fc.hal_score * COMMA),
      score_C: Number.isFinite(er.hal_score) ? er.hal_score : 0.5,
    });
    process.stdout.write(`#${i + 1}/${items.length} ${it.id} gt=${it.gt_hallucination ? 'H' : 'C'} A=${sA?.toFixed(2) ?? 'na'} B0=${fc.hal_score.toFixed(2)} q=${fc.providers_used}\n`);
    const delay = Number(process.env.DELAY_MS ?? '250');
    if (delay > 0 && i < items.length - 1) await new Promise((res) => setTimeout(res, delay));
  }

  // Build scorer arrays. Ensemble scorers (A/B0/B) use the quorum subset; C (pure) uses all.
  const quorumRows = rows.filter((r) => r.quorum && r.score_A !== null);
  const labQ = quorumRows.map((r) => r.gt);
  const labAll = rows.map((r) => r.gt);

  const results = [
    summarize('A_plain_majority', quorumRows.map((r) => r.score_A), labQ, 0.5),
    summarize('B0_ensemble_noComma', quorumRows.map((r) => r.score_B0), labQ, 0.5),
    summarize('B_HAL_comma', quorumRows.map((r) => r.score_B), labQ, 0.5),
    summarize('C_extractor_prod', rows.map((r) => r.score_C), labAll, 0.25),
    summarize('C_extractor_at0.5', rows.map((r) => r.score_C), labAll, 0.5),
  ];

  const out = {
    run_at: new Date().toISOString(),
    corpus_size: items.length, quorum_size: quorumRows.length, degraded,
    providers: providers.map((p: any) => ({ name: p.name, model: p.model })),
    calls_made_this_run: callsMade, est_cost_usd: 0, // free-tier
    comma_ratio: COMMA,
    results, rows,
  };
  fs.writeFileSync(path.join(DATA, 'ablation-results.json'), JSON.stringify(out, null, 2));

  // Print the headline table.
  console.log('\n=== ABLATION: A vs B vs C (positive class = hallucination) ===');
  console.log(`corpus=${items.length}  quorum_subset=${quorumRows.length}  degraded=${degraded}  calls_this_run=${callsMade} (free-tier $0)`);
  const pad = (s: any, n: number) => String(s).padEnd(n);
  console.log(pad('scorer', 22) + pad('N', 5) + pad('thr', 6) + pad('AUC', 8) + pad('F1', 8) + pad('prec', 8) + pad('recall', 8) + pad('veto%', 8) + pad('sep', 8));
  for (const r of results) {
    console.log(pad(r.scorer, 22) + pad(r.n, 5) + pad(r.threshold, 6) + pad(r.auc, 8) + pad(r.f1, 8) + pad(r.precision, 8) + pad(r.recall, 8) + pad(r.veto_rate, 8) + pad(r.separation, 8));
  }
  const A = results[0]!, B0 = results[1]!, B = results[2]!, C = results[3]!;
  console.log('\n=== VERDICT ===');
  console.log(`Comma isolation (B vs B0, same ensemble): ΔAUC=${(B.auc - B0.auc).toFixed(4)}  Δsep=${(B.separation - B0.separation).toFixed(4)}  Δveto=${(B.veto_rate - B0.veto_rate).toFixed(4)}`);
  console.log(`HAL vs plain majority (B vs A): ΔAUC=${(B.auc - A.auc).toFixed(4)}  ΔF1=${(B.f1 - A.f1).toFixed(4)}  Δsep=${(B.separation - A.separation).toFixed(4)}`);
  console.log(`Ensemble vs blind extractor (B vs C@prod): ΔAUC=${(B.auc - C.auc).toFixed(4)}  ΔF1=${(B.f1 - C.f1).toFixed(4)}`);
  console.log(`\nwrote ${path.join(DATA, 'ablation-results.json')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
