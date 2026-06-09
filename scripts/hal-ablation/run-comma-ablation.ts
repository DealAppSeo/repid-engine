/**
 * S-COMMA-R2 Phase 1 (headline) — test the Pythagorean comma as a CYCLE-CLOSURE DRIFT veto.
 *
 * R1 proved the comma as a SCALAR MULTIPLIER cannot change AUC (monotone ⇒ rank-invariant). This
 * tests the correct operationalization P-003 should claim: a cyclic-consensus DRIFT threshold.
 *
 * Drift: over the N-validator belief cycle (beliefs = per-provider risk in [0,1], sorted to fix the
 * loop), take the product of pairwise agreement RATIOS min/max around the loop (incl. wraparound).
 * Perfect closure (all beliefs equal) ⇒ product 1 ⇒ drift 0. Divergence ⇒ product < 1 ⇒ drift = 1−product.
 * Requires ≥3 validators (a 2-cycle is degenerate), matching the comma/SBFA convention.
 *
 * Four conditions over the labeled corpus (≥150), positive class = hallucination:
 *   A  flat majority vote (level signal)         — veto if FALSE-fraction ≥ 0.5
 *   B  comma-drift veto                           — veto if drift > comma excess (531441/524288 − 1 = 0.013643)
 *   C  tuned-arbitrary-threshold drift veto       — grid-search best threshold on drift
 *   D  live extractor (strictness 1)              — veto if hal_score ≥ 0.25
 *
 * DECISIVE: B vs C. Because C picks the F1-max threshold IN-SAMPLE, C ≥ B in-sample by construction;
 * the honest test is 5-fold CROSS-VALIDATED held-out F1 — B's fixed comma threshold vs C's
 * train-tuned threshold on the same test folds. B > C (held out) ⇒ the comma value generalizes /
 * is load-bearing (P-003 stands, re-scoped). B ≈ C ⇒ mechanism real but the specific Pythagorean
 * value is decorative (keep the drift gate, drop the "Pythagorean" claim). Report straight (RULE-10).
 *
 * Free-tier 3-validator panel (fireworks suspended, gemini/deepseek quota-dead → all-groq+cerebras):
 *   groq/llama-3.1-8b-instant · groq/llama-3.3-70b-versatile · cerebras/zai-glm-4.7. Cached → $0 re-runs.
 *   LIMIT=N for a smoke subset; CACHE_ONLY=1 to compute from cache without calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { factCheck, factCheckOptsFromEnv, FactCheckProviderCfg, ProviderVerdict } from '../../src/hal/fact-check';
import { evaluate } from '../../src/hal/lib/evaluate';

const COMMA_EXCESS = 531441 / 524288 - 1; // 0.0136432647705078
const DATA = path.join(__dirname, 'data');
const CACHE = path.join(__dirname, 'cache-r2b'); // 4-validator panel (adds gpt-4o-mini; free-tier exhausted)
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CACHE_ONLY = process.env.CACHE_ONLY === '1';

interface CorpusItem { id: string; text: string; gt_hallucination: boolean; category: string; source: string; }
interface Cached { verdicts: ProviderVerdict[]; }

const GROQ = process.env.GROQ_API_KEY ?? '';
const CEREBRAS = process.env.CEREBRAS_API_KEY ?? '';
const OPENAI = process.env.OPENAI_API_KEY ?? '';
function panel(): FactCheckProviderCfg[] {
  const out: FactCheckProviderCfg[] = [];
  if (GROQ) {
    out.push({ name: 'groq-8b', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: GROQ, model: 'llama-3.1-8b-instant' });
    out.push({ name: 'groq-70b', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: GROQ, model: 'llama-3.3-70b-versatile' });
  }
  if (CEREBRAS) out.push({ name: 'cerebras', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: CEREBRAS, model: 'zai-glm-4.7' });
  // Free-tier exhausted mid-sprint (fireworks suspended, gemini/deepseek quota-dead) → one cheap paid
  // validator (gpt-4o-mini, ~$0.0001/call) keeps the cycle ≥3 reliably; ~$0.02 total, far under the $5 ceiling.
  if (OPENAI) out.push({ name: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: OPENAI, model: 'gpt-4o-mini' });
  return out;
}

let callsMade = 0;
async function getVerdicts(item: CorpusItem, providers: FactCheckProviderCfg[], opts: any): Promise<ProviderVerdict[] | null> {
  const key = crypto.createHash('sha256').update('r2|' + item.text).digest('hex').slice(0, 32);
  const file = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(file)) return (JSON.parse(fs.readFileSync(file, 'utf8')) as Cached).verdicts;
  if (CACHE_ONLY) return null;
  const r = await factCheck(item.text, providers, opts);
  callsMade += providers.length;
  const ok = r.verdicts.filter((v) => v.verdict !== 'ERROR').length;
  if (ok >= 3) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ verdicts: r.verdicts })); }
  return r.verdicts;
}

/** Per-provider risk in [0,1]: confident-FALSE high, confident-TRUE low. Mirrors fact-check.providerRisk. */
function providerRisk(v: ProviderVerdict): number {
  const c = v.confidence / 100;
  if (v.verdict === 'FALSE') return 0.5 + 0.5 * c;
  if (v.verdict === 'TRUE') return 0.5 - 0.5 * c;
  return 0.5;
}
function majorityFalseFrac(verdicts: ProviderVerdict[]): number | null {
  const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
  if (!ok.length) return null;
  let f = 0, u = 0;
  for (const v of ok) { if (v.verdict === 'FALSE') f++; else if (v.verdict === 'UNCERTAIN') u++; }
  return (f + 0.5 * u) / ok.length;
}
/** Cycle-closure drift = |∏ pairwise(min/max) − 1| over the sorted belief loop. Needs ≥3 beliefs.
 *  shift>0 maps beliefs to [shift, shift+1] so confident-TRUE (risk≈0) doesn't force the ratio→0
 *  (the literal [0,1] form saturates: any TRUE+FALSE pair drives drift→1). shift=0 = literal form. */
function commaDrift(beliefs: number[], shift = 0): number | null {
  if (beliefs.length < 3) return null;
  const b = [...beliefs].map((x) => x + shift).sort((x, y) => x - y);
  const eps = 1e-9;
  let prod = 1;
  for (let i = 0; i < b.length; i++) {
    const cur = b[i]!, nxt = b[(i + 1) % b.length]!;
    prod *= (Math.min(cur, nxt) + eps) / (Math.max(cur, nxt) + eps);
  }
  return Math.abs(prod - 1);
}

// ---- metrics ----
function auc(scores: number[], labels: boolean[]): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const rank = new Array<number>(n);
  let i = 0;
  while (i < n) { let j = i; while (j + 1 < n && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++; const a = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rank[idx[k]!] = a; i = j + 1; }
  let sp = 0, np = 0, nn = 0;
  for (let t = 0; t < n; t++) { if (labels[t]) { sp += rank[t]!; np++; } else nn++; }
  return np && nn ? (sp - (np * (np + 1)) / 2) / (np * nn) : NaN;
}
function f1At(scores: number[], labels: boolean[], thr: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < scores.length; i++) { const p = scores[i]! > thr; if (labels[i]) p ? tp++ : fn++; else p ? fp++ : tn++; }
  const prec = tp / (tp + fp || 1), rec = tp / (tp + fn || 1);
  return { f1: (2 * prec * rec) / (prec + rec || 1), precision: prec, recall: rec, veto_rate: (tp + fp) / (scores.length || 1), tp, fp, fn, tn };
}
function bestThreshold(scores: number[], labels: boolean[]): { thr: number; f1: number } {
  const cands = Array.from(new Set([...scores, COMMA_EXCESS, 0])).sort((a, b) => a - b);
  let best = { thr: 0, f1: -1 };
  for (const t of cands) { const m = f1At(scores, labels, t); if (m.f1 > best.f1) best = { thr: t, f1: m.f1 }; }
  return best;
}
const r4 = (x: number) => +x.toFixed(4);

(async () => {
  const corpus: CorpusItem[] = JSON.parse(fs.readFileSync(path.join(DATA, 'corpus.json'), 'utf8'));
  const items = corpus.slice(0, LIMIT);
  const providers = panel();
  const opts = factCheckOptsFromEnv();
  console.log(`[comma] ${items.length} items · panel=${providers.map((p) => `${p.name}`).join(',')} (${providers.length}) · comma_excess=${COMMA_EXCESS.toFixed(6)}`);
  if (!CACHE_ONLY && providers.length < 3) { console.error('[comma] need ≥3 validators for cycle-closure; have', providers.length); process.exit(1); }

  const rows: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const verdicts = await getVerdicts(it, providers, opts);
    if (verdicts === null) continue;
    const ok = verdicts.filter((v) => v.verdict !== 'ERROR');
    const beliefs = ok.map(providerRisk);
    const drift = commaDrift(beliefs);              // literal [0,1] form (saturates)
    const drift_shifted = commaDrift(beliefs, 0.5); // non-saturating ([0.5,1.5]) — fair mechanism test
    const er = await evaluate(it.text, it.text, { domain: 'general', certainty: 0.8, strictness: 1 });
    rows.push({
      id: it.id, gt: it.gt_hallucination, n_ok: ok.length, quorum: ok.length >= 3,
      drift, drift_shifted, a_score: majorityFalseFrac(verdicts), d_score: Number.isFinite(er.hal_score) ? er.hal_score : 0.5,
    });
    if (!CACHE_ONLY) { process.stdout.write(`#${i + 1}/${items.length} ${it.id} gt=${it.gt_hallucination ? 'H' : 'C'} q=${ok.length} drift=${drift?.toFixed(4) ?? 'na'}\n`); await new Promise((r) => setTimeout(r, Number(process.env.DELAY_MS ?? '300'))); }
  }

  const Q = rows.filter((r) => r.quorum && r.drift !== null && r.a_score !== null);
  const lab = Q.map((r) => r.gt);
  const aScore = Q.map((r) => r.a_score as number);
  const dScore = Q.map((r) => r.d_score as number);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

  // B-vs-C verdict for a given drift statistic: in-sample + 5-fold CROSS-VALIDATED held-out F1.
  function bcVerdict(driftArr: number[]) {
    const aucD = auc(driftArr, lab);
    const B = f1At(driftArr, lab, COMMA_EXCESS);
    const Cins = bestThreshold(driftArr, lab);
    const K = 5; const fB: number[] = [], fC: number[] = [], thr: number[] = [];
    for (let k = 0; k < K; k++) {
      const tr: number[] = [], trL: boolean[] = [], te: number[] = [], teL: boolean[] = [];
      for (let i = 0; i < driftArr.length; i++) { if (i % K === k) { te.push(driftArr[i]!); teL.push(lab[i]!); } else { tr.push(driftArr[i]!); trL.push(lab[i]!); } }
      if (!te.length || !tr.length) continue;
      const cThr = bestThreshold(tr, trL).thr;
      fB.push(f1At(te, teL, COMMA_EXCESS).f1); fC.push(f1At(te, teL, cThr).f1); thr.push(cThr);
    }
    return { auc: r4(aucD), B_f1: r4(B.f1), B_veto: r4(B.veto_rate), C_insample_f1: r4(Cins.f1), C_thr: r4(Cins.thr), cvB: r4(mean(fB)), cvC: r4(mean(fC)), dBC: r4(mean(fB) - mean(fC)) };
  }

  const driftLit = Q.map((r) => r.drift as number);
  const driftShift = Q.map((r) => r.drift_shifted as number);
  const litV = bcVerdict(driftLit), shiftV = bcVerdict(driftShift);
  const aucA = auc(aScore, lab), aucD = auc(dScore, lab);
  const A = f1At(aScore, lab, 0.5), D = f1At(dScore, lab, 0.25);
  const estCost = r4((callsMade / Math.max(1, panel().length)) * 0.0001); // ≈ gpt-4o-mini share only

  const out = {
    note: 'free-tier exhausted (fireworks suspended, gemini/deepseek quota) → 4-validator panel groq-8b/groq-70b/cerebras/gpt-4o-mini',
    comma_excess: COMMA_EXCESS, corpus: items.length, quorum_n: Q.length, calls_made_this_run: callsMade, est_cost_usd: estCost,
    baselines_auc: { A_majority: r4(aucA), D_extractor: r4(aucD) },
    A_majority: { thr: 0.5, f1: r4(A.f1), precision: r4(A.precision), recall: r4(A.recall), veto_rate: r4(A.veto_rate) },
    D_extractor: { thr: 0.25, f1: r4(D.f1), precision: r4(D.precision), recall: r4(D.recall), veto_rate: r4(D.veto_rate) },
    drift_literal: litV, drift_shifted_nonsaturating: shiftV, rows: Q,
  };
  fs.writeFileSync(path.join(DATA, 'comma-ablation-results.json'), JSON.stringify(out, null, 2));

  const pad = (s: any, n: number) => String(s).padEnd(n);
  console.log(`\n=== COMMA AS CYCLE-CLOSURE DRIFT — A/B/C/D (quorum N=${Q.length}, ≥3 validators, panel=${panel().length}) ===`);
  console.log(`baselines: majority AUC=${r4(aucA)} (A F1=${r4(A.f1)}) | extractor AUC=${r4(aucD)} (D F1=${r4(D.f1)})`);
  console.log(pad('drift variant', 20) + pad('AUC', 8) + pad('B(comma)F1', 12) + pad('B veto%', 9) + pad('C(tuned)F1', 12) + pad('cvB', 8) + pad('cvC', 8) + pad('ΔB-C', 8));
  console.log(pad('literal [0,1]', 20) + pad(litV.auc, 8) + pad(litV.B_f1, 12) + pad(litV.B_veto, 9) + pad(litV.C_insample_f1, 12) + pad(litV.cvB, 8) + pad(litV.cvC, 8) + pad(litV.dBC, 8));
  console.log(pad('shifted [.5,1.5]', 20) + pad(shiftV.auc, 8) + pad(shiftV.B_f1, 12) + pad(shiftV.B_veto, 9) + pad(shiftV.C_insample_f1, 12) + pad(shiftV.cvB, 8) + pad(shiftV.cvC, 8) + pad(shiftV.dBC, 8));
  console.log(`\n=== DECISIVE B vs C (5-fold held-out F1) ===`);
  for (const [name, v] of [['literal', litV], ['shifted', shiftV]] as const) {
    const verdict = Math.abs(v.dBC) <= 0.01
      ? `B ≈ C → mechanism real but SPECIFIC comma value decorative (keep gate, drop "Pythagorean")`
      : v.dBC > 0 ? `B > C → comma value load-bearing (P-003 stands, re-scoped to cyclic-drift)` : `B < C → tuned beats comma → value not load-bearing`;
    const disc = v.auc >= 0.58 ? '' : ` [drift AUC ${v.auc} ≈/below chance → non-discriminative for hallucination]`;
    console.log(`  ${name}: cvB=${v.cvB} cvC=${v.cvC} ΔB−C=${v.dBC} → ${verdict}${disc}`);
  }
  console.log(`calls=${callsMade} est_cost≈$${estCost} (groq+cerebras free; gpt-4o-mini share only)`);
  console.log(`wrote ${path.join(DATA, 'comma-ablation-results.json')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
