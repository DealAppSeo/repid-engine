/**
 * XC1 / A3: Compute ANFIS shadow vs static from live anfis_routing_logs (110+ rows per MD verified).
 * Tolerant: if no SUPABASE keys, BLOCKED + plan.
 * Fields from inserts (route.ts): request_text, selected_model (ANFIS pick?), confidence_score (qual proxy), cost_saved (benefit of ANFIS?), latency_ms.
 * Group by category (parse from prompt or note; MD per cat).
 * Deltas: cost (cost_saved >0 = ANFIS cheaper), quality (confidence high + low latency).
 * Propose: for cats where ANFIS beats (cheaper, qual not worse), promote behind reversible flag (A4).
 * Ground: use actual query when keyed. Support T12 labels.
 * Cite: MD verified 110 rows, types for cols, route.ts inserts, this script.
 * Run: npx ts-node scripts/compute-anfis-a3-shadow.ts (with keys via dotenvx or env).
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.log('BLOCKED: no SUPABASE_URL or SERVICE key (use dotenvx or export). Per sprint MD: 110 rows exist, A3 computable NOW in keyed env.');
  console.log('Plan: query logs, group by cat (or prompt heuristic), avg cost_saved (ANFIS benefit), confidence/latency (qual). Propose promote per cat where cost_saved >0 and confidence >= static baseline.');
  process.exit(0);
}

const supabase = createClient(url, key);

interface LogRow {
  request_text?: string;
  selected_model?: string;
  confidence_score?: number;
  cost_saved?: number;
  latency_ms?: number;
  // add more from types if present (category, static vs anfis if logged)
}

(async () => {
  console.log('[A3] querying anfis_routing_logs (tolerant, live if keys)...');
  const { data: rows, error, count } = await supabase
    .from('anfis_routing_logs')
    .select('*', { count: 'exact' })
    .limit(200);  // 110+ per MD

  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }
  console.log(`[A3] rows: ${rows?.length} (count ${count || 'n/a'})`);

  // Simple group: by heuristic cat from request_text, or 'unknown'
  const byCat: Record<string, { count: number; totalCostSaved: number; avgConf: number; avgLat: number; beats: number }> = {};

  for (const r of (rows as LogRow[] || [])) {
    const text = (r.request_text || '').toLowerCase();
    let cat = 'unknown';
    if (/classify|fact|yes\/no|true\/false/.test(text)) cat = 'factual';
    else if (/code|function|js|python|rust/.test(text)) cat = 'code';
    else if (/math|sum|integral|probability|bayes/.test(text)) cat = 'math';
    else if (/creative|story|poem|dragon|magic/.test(text)) cat = 'creative';
    else if (/opinion|best|should|believe/.test(text)) cat = 'opinion';
    else if (/time|2026|now|current|latest/.test(text)) cat = 'time-sensitive';

    if (!byCat[cat]) byCat[cat] = { count: 0, totalCostSaved: 0, avgConf: 0, avgLat: 0, beats: 0 };
    const b = byCat[cat];
    b.count++;
    b.totalCostSaved += r.cost_saved || 0;
    b.avgConf += r.confidence_score || 0;
    b.avgLat += r.latency_ms || 0;
    // beat heuristic: cost_saved >0 (cheaper) and confidence >=0.7 (qual ok)
    if ((r.cost_saved || 0) > 0 && (r.confidence_score || 0) >= 0.7) b.beats++;
  }

  for (const [cat, b] of Object.entries(byCat)) {
    b.avgConf /= b.count;
    b.avgLat /= b.count;
    const avgCostSaved = b.totalCostSaved / b.count;
    console.log(`[A3] ${cat}: n=${b.count}, avgCostSaved=${avgCostSaved.toFixed(4)}, avgConf=${b.avgConf.toFixed(3)}, avgLat=${b.avgLat.toFixed(0)}ms, beats=${b.beats} (${(b.beats/b.count*100).toFixed(0)}%)`);
  }

  // Propose: cats with >50% beats and avgCostSaved >0 : promote behind flag
  console.log('\n[A3] PROPOSE PROMOTE (cheaper + qual not worse, reversible flag):');
  for (const [cat, b] of Object.entries(byCat)) {
    const pct = b.beats / b.count;
    if (pct > 0.5 && (b.totalCostSaved / b.count) > 0) {
      console.log(`  - ${cat}: promote ANFIS (beats ${ (pct*100).toFixed(0)}%, avg saved ${(b.totalCostSaved/b.count).toFixed(4)})`);
    }
  }
  console.log('Run with keys for live 110+ data. Feed T12 for labels/quality. Ground only.');
  process.exit(0);
})();
