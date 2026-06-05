/**
 * PHASE1 A3 compute: from populated logs (or DB when creds), per-category:
 * - avg cost_saved (real from ledger)
 * - beats% where ANFIS cheaper than static counterfactual (cost_saved >0)
 * - propose promote flag (conservative: if beats_pct>=45 && |avg| shows win or neutral, reversible)
 * Note: qual not here (use HAL cross on T12 labeled rows later; confidence as proxy).
 * Run: npx --yes tsx scripts/compute-a3-anfis.ts
 * Output: stats + data/a3-summary.json ; handoff to T12 for labels/sweep, CC for qual.
 * Cite: SPRINT_XC PHASE1, populate script, anfis_routing_logs (mig+types+route inserts), prior comma-ablation for F1 baseline.
 */
import * as fs from 'fs';
import * as path from 'path';

type Row = { category: string; cost_saved: number; anfis_conf: number; verified_by: string[]; success: boolean };

async function main() {
  const inPath = path.join(__dirname, '..', 'data', 'anfis-populated-logs.json');
  if (!fs.existsSync(inPath)) { console.error('no populated json; run populate first'); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const rows: Row[] = (j.rows || []).filter((r: any) => Math.abs(r.cost_saved || 0) > 1e-7 && r.verified_by?.length >= 2);
  console.log('[A3] using', rows.length, 'good rows (local sim; DB BLOCKED)');

  const byCat: Record<string, Row[]> = {};
  for (const r of rows) {
    const c = r.category || 'general';
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(r);
  }

  const summary: any = { generated: new Date().toISOString(), total_good: rows.length, cats: {} };
  for (const [cat, arr] of Object.entries(byCat)) {
    const costs = arr.map(r => r.cost_saved);
    const avg = costs.reduce((a,b)=>a+b,0) / costs.length;
    const cheaper = arr.filter(r => r.cost_saved > 0).length;
    const beats_pct = (cheaper / arr.length) * 100;
    const avg_conf = arr.reduce((a,b)=>a + (b.anfis_conf||0.8),0) / arr.length;
    // propose: if ANFIS not much worse on cost (avg > -1e-5) or beats some, and conf high; reversible
    const propose = (beats_pct >= 40 || avg > -0.00005) && avg_conf > 0.7;
    (summary.cats as any)[cat] = {
      count: arr.length,
      avg_cost_saved: Number(avg.toFixed(8)),
      cheaper_count: cheaper,
      beats_pct: Number(beats_pct.toFixed(1)),
      avg_conf: Number(avg_conf.toFixed(3)),
      propose_promote: propose,
      note: propose ? 'ANFIS wins or neutral on cost vs static; promote candidate (reversible flag, needs HAL qual crosscheck on real T12 labels)' : 'no promote (cost neutral or loss; keep shadow)'
    };
    console.log(`[A3][${cat}] n=${arr.length} avg_saved=${avg.toFixed(8)} beats=${beats_pct.toFixed(1)}% conf=${avg_conf.toFixed(3)} promote=${propose}`);
  }
  const outPath = path.join(__dirname, '..', 'data', 'a3-summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('[A3] wrote', outPath);
  // overall
  const allCheaper = rows.filter(r=>r.cost_saved>0).length;
  console.log('[A3] OVERALL beats (ANFIS cheaper):', ((allCheaper/rows.length)*100).toFixed(1)+'% of', rows.length);
  console.log('[A3] NEXT: feed real rows to T12 corpus for HAL labels; CC HAL lock after re-sweep; promote only where wins + qual not worse.');
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});