import { runTier1Benchmark } from './src/services/hal-tester';
import { sendTelegramAlert } from './src/routes/telegram';
import { db } from './src/db';
require('dotenv').config();

async function runHAEEEpoch() {
  console.log('[HAEE] Starting epoch...');
  try {
    const supabase = db;
    const { data: prevMetrics } = await supabase.from('hal_antifragility_metrics').select('domain_metrics').order('created_at', { ascending: false }).limit(1);
    const prevF1 = (prevMetrics?.[0]?.domain_metrics as any)?.f1_score || 0;
    
    const result = await runTier1Benchmark();
    if (!result) return;
    
    const { metrics } = result;
    const currentF1 = metrics.f1_score / 100;
    const pF1 = prevF1 / 100;
    const antifragility = pF1 > 0 ? (currentF1 - pF1) / pF1 : 0;
    
    await supabase.from('hal_antifragility_metrics').insert({
      domain_metrics: { ...metrics, antifragility_score: antifragility },
      is_antifragile: antifragility >= 0,
      hallucination_rate_target_met: true
    });
    
    const emoji = antifragility > 0 ? '📈' : antifragility < 0 ? '📉' : '➡️';
    await sendTelegramAlert(
      `🧠 <b>HAEE EPOCH COMPLETE</b>\n`
      + `Precision: ${metrics.precision}%\n`
      + `Recall: ${metrics.recall}%\n`
      + `F1 Score: ${metrics.f1_score}%\n`
      + `FP Rate: ${metrics.false_positive_rate}%\n`
      + `${emoji} Antifragility: ${(antifragility * 100).toFixed(2)}%\n`
      + `Prompts tested: ${metrics.total_prompts}\n`
      + `\nHAL is ${antifragility > 0 ? 'getting stronger' : antifragility < 0 ? 'degrading — check red team' : 'stable'}`
    );
    console.log(`[HAEE] Epoch complete. F1: ${metrics.f1_score}%, Antifragility: ${(antifragility*100).toFixed(2)}%`);
  } catch(e: any) {
    console.error('[HAEE] Epoch failed:', e.message);
  }
}
runHAEEEpoch();
