import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function getHALAccuracyMetrics() {
  try {
    // Try to query the view
    const { data, error } = await supabase
      .from('hal_accuracy_summary')
      .select('*');
    
    if (error) {
      if (error.code === 'P0001' || error.message.includes('does not exist')) {
        console.warn('[Metrics] hal_accuracy_summary view does not exist yet. Using fallback computation.');
        return await computeMetricsInApp();
      }
      throw error;
    }
    return data;
  } catch (e: any) {
    console.error(`[Metrics] Query failed: ${e.message}`);
    return null;
  }
}

async function computeMetricsInApp() {
  // Fallback: Compute metrics in application code by joining tables
  const { data: results } = await supabase.from('hal_runner_results').select('prompt_id, hal_vetoed, gen_provider, gen_model, hal_mode');
  const { data: prompts } = await supabase.from('hal_test_prompts').select('prompt_id, domain, category');

  if (!results || !prompts) return [];

  const promptMap = new Map(prompts.map(p => [p.prompt_id, p]));
  
  const metricsMap = new Map<string, any>();

  for (const r of results) {
    const p = promptMap.get(r.prompt_id);
    if (!p) continue;

    const key = `${r.gen_provider}|${r.gen_model}|${r.hal_mode}|${p.domain}`;
    if (!metricsMap.has(key)) {
      metricsMap.set(key, {
        gen_provider: r.gen_provider,
        gen_model: r.gen_model,
        hal_mode: r.hal_mode,
        domain: p.domain,
        tp: 0, fp: 0, tn: 0, fn: 0
      });
    }

    const m = metricsMap.get(key);
    const isHallucination = p.category === 'factual_error';
    
    if (isHallucination && r.hal_vetoed) m.tp++;
    else if (!isHallucination && r.hal_vetoed) m.fp++;
    else if (!isHallucination && !r.hal_vetoed) m.tn++;
    else if (isHallucination && !r.hal_vetoed) m.fn++;
  }

  return Array.from(metricsMap.values()).map(m => ({
    ...m,
    precision: m.tp / (m.tp + m.fp) || 0,
    recall: m.tp / (m.tp + m.fn) || 0,
    accuracy: (m.tp + m.tn) / (m.tp + m.fp + m.tn + m.fn) || 0
  }));
}
