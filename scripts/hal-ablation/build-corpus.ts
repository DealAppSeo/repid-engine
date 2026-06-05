/**
 * S-HAL-ABLATION Phase 1 — build a ≥150-case labeled corpus to disk (reproducible at $0).
 *
 * Sources:
 *   (1) hal_test_cases (109 labeled: prompt_text + expected_hallucination) — the existing cc-measure corpus.
 *   (2) TruthfulQA (public benchmark; data/TruthfulQA.csv fetched from sylinrl/TruthfulQA). For a
 *       deterministic slice of questions we emit TWO labeled claims each:
 *         "<Question> <Best Answer>"          → hallucination=false (correct)
 *         "<Question> <Best Incorrect Answer>" → hallucination=true  (plausible-but-false)
 *
 * Output: data/corpus.json — [{ id, text, gt_hallucination, category, source }]. Ground truth is
 * the `gt_hallucination` boolean (true = the claim IS a hallucination / factually false).
 *
 * MEASURE-ONLY. No scoring/threshold/penalty change. Run: ts-node scripts/hal-ablation/build-corpus.ts
 */
import { db } from '../../src/db';
import * as fs from 'fs';
import * as path from 'path';

const DATA = path.join(__dirname, 'data');
const TQA_SLICE = Number(process.env.TQA_SLICE ?? '28'); // 28 questions → 56 claims; 109+56=165 ≥150

interface CorpusItem { id: string; text: string; gt_hallucination: boolean; category: string; source: string; }

/** Minimal RFC4180 CSV parser (handles quoted fields with commas/newlines/escaped quotes). */
function parseCSV(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

(async () => {
  const out: CorpusItem[] = [];

  // (1) hal_test_cases
  const { data: cases, error } = await db
    .from('hal_test_cases')
    .select('id, prompt_text, expected_hallucination, category')
    .order('id');
  if (error || !cases) { console.error('read hal_test_cases failed:', error?.message); process.exit(1); }
  for (const c of cases as any[]) {
    out.push({
      id: `htc-${c.id}`,
      text: String(c.prompt_text),
      gt_hallucination: c.expected_hallucination === true,
      category: c.category ?? 'factual',
      source: 'hal_test_cases',
    });
  }
  console.log(`[corpus] hal_test_cases: ${out.length} items`);

  // (2) TruthfulQA slice
  const tqaPath = path.join(DATA, 'TruthfulQA.csv');
  if (fs.existsSync(tqaPath)) {
    const rows = parseCSV(fs.readFileSync(tqaPath, 'utf8'));
    const header = rows[0]!;
    const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const qi = col('Question'), bi = col('Best Answer'), wi = col('Best Incorrect Answer'), ci = col('Category');
    let added = 0;
    for (let r = 1; r < rows.length && added < TQA_SLICE; r++) {
      const q = (rows[r]![qi] ?? '').trim();
      const best = (rows[r]![bi] ?? '').trim();
      const worst = (rows[r]![wi] ?? '').trim();
      const cat = (rows[r]![ci] ?? 'misc').trim();
      if (!q || !best || !worst) continue;
      out.push({ id: `tqa-${r}-T`, text: `${q} ${best}`, gt_hallucination: false, category: `tqa:${cat}`, source: 'truthfulqa' });
      out.push({ id: `tqa-${r}-F`, text: `${q} ${worst}`, gt_hallucination: true, category: `tqa:${cat}`, source: 'truthfulqa' });
      added++;
    }
    console.log(`[corpus] truthfulqa: +${added * 2} items (${added} questions × 2)`);
  } else {
    console.warn(`[corpus] TruthfulQA.csv not found at ${tqaPath} — corpus is DB-only`);
  }

  const halluc = out.filter((o) => o.gt_hallucination).length;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'corpus.json'), JSON.stringify(out, null, 2));
  console.log(`[corpus] TOTAL ${out.length} items → ${halluc} hallucination / ${out.length - halluc} correct`);
  console.log(`[corpus] wrote ${path.join(DATA, 'corpus.json')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
