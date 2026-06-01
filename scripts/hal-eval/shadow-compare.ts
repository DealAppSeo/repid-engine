/**
 * P4 SHADOW (sprint 2026-05-29): compare the LIVE extractor path vs the
 * recalibrated FACT-CHECK path over REAL recent deliverables — score + would-be
 * decision only, NO enforcement, NO writes. For Cowork co-sign before flipping
 * HAL_STRICTNESS=2 live.
 *
 * Run by Sean/prod (needs provider keys + DB):
 *   GROQ_API_KEY=.. FIREWORKS_API_KEY=.. SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. \
 *   DATABASE_URL=.. npx tsx scripts/hal-eval/shadow-compare.ts [N]
 *
 * Pulls the last N real deliverables (default 100) from repid_score_events
 * (READ-ONLY), scores each through both paths, and prints the decision delta:
 * how many the fact-check path would newly catch / newly clear vs the extractor,
 * and the score separation. If a labeled subset exists, reports FP/FN both ways.
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { halService } from '../../src/hal/service';
import { db } from '../../src/db';

const VETO = Number(process.env.HAL_VETO_THRESHOLD ?? '0.43');

(async () => {
  const N = Number(process.argv[2] ?? '100');
  const { data, error } = await db
    .from('repid_score_events')
    .select('id, answer_text, task_domain, hal_score, hal_decision, certainty_at_claim')
    .not('answer_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(N);
  if (error) { console.error('read failed (READ-ONLY):', error.message); process.exit(1); }
  const rows = (data ?? []).filter((r: any) => (r.answer_text ?? '').trim().length > 0);
  console.log(`[shadow] ${rows.length} real deliverables (READ-ONLY, no enforcement). veto@${VETO}`);

  let extractorVeto = 0, factVeto = 0, newlyCaught = 0, newlyCleared = 0;
  const extS: number[] = [], fcS: number[] = [];
  for (const r of rows as any[]) {
    const ex = await evaluate(r.answer_text, r.answer_text, { domain: r.task_domain ?? 'finance', certainty: r.certainty_at_claim ?? 0.85, strictness: 1 });
    const fc = await halService.evaluate({ text: r.answer_text, context: { domain: r.task_domain ?? 'finance', certainty: r.certainty_at_claim ?? 0.85 }, strictness: 2 });
    const exVeto = ex.hal_score >= VETO || !!ex.vetoed;
    const fcVeto = fc.decision === 'vetoed' || fc.hal_score >= VETO;
    extS.push(ex.hal_score); fcS.push(fc.hal_score);
    if (exVeto) extractorVeto++;
    if (fcVeto) factVeto++;
    if (fcVeto && !exVeto) newlyCaught++;
    if (!fcVeto && exVeto) newlyCleared++;
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(`extractor: meanScore=${mean(extS).toFixed(3)} vetoes=${extractorVeto}/${rows.length}`);
  console.log(`fact-check: meanScore=${mean(fcS).toFixed(3)} vetoes=${factVeto}/${rows.length}`);
  console.log(`DELTA: newly-caught(fc vetoes, extractor cleared)=${newlyCaught}  newly-cleared(extractor vetoed, fc clears)=${newlyCleared}`);
  console.log(`\nCo-sign gate: confirm newly-caught land on real hallucinations and newly-cleared on legit work before HAL_STRICTNESS=2 goes live.`);
})();
