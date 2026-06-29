import { db } from '../db';
import { halService } from '../hal/service';
import { buildFactCheckProviders } from '../hal/fact-check';

export interface ProviderStats {
  model_version: string;
  category: string;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  weight: number;
}

// Fallback weights dictionary in case DB is empty or a model is un-evaluated
const DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  openai: { default: 0.90, factual: 0.95, math: 0.92, code: 0.95, creative: 0.85, opinion: 0.80, 'time-sensitive': 0.90 },
  anthropic: { default: 0.92, factual: 0.96, math: 0.94, code: 0.96, creative: 0.88, opinion: 0.82, 'time-sensitive': 0.91 },
  deepseek: { default: 0.88, factual: 0.94, math: 0.95, code: 0.94, creative: 0.85, opinion: 0.80, 'time-sensitive': 0.89 },
  gemini: { default: 0.82, factual: 0.88, math: 0.84, code: 0.85, creative: 0.80, opinion: 0.75, 'time-sensitive': 0.85 },
  mistral: { default: 0.78, factual: 0.82, math: 0.79, code: 0.80, creative: 0.76, opinion: 0.72, 'time-sensitive': 0.80 },
  qwen: { default: 0.78, factual: 0.82, math: 0.80, code: 0.81, creative: 0.76, opinion: 0.72, 'time-sensitive': 0.80 },
  cerebras: { default: 0.72, factual: 0.75, math: 0.78, code: 0.75, creative: 0.68, opinion: 0.65, 'time-sensitive': 0.72 },
  groq: { default: 0.75, factual: 0.78, math: 0.80, code: 0.78, creative: 0.70, opinion: 0.68, 'time-sensitive': 0.74 }
};

function getFallbackWeight(model: string, category: string): number {
  const m = model.toLowerCase();
  let brand = 'other';
  if (m.includes('gpt') || m.includes('openai')) brand = 'openai';
  else if (m.includes('claude') || m.includes('anthropic')) brand = 'anthropic';
  else if (m.includes('deepseek')) brand = 'deepseek';
  else if (m.includes('gemini') || m.includes('gemma')) brand = 'gemini';
  else if (m.includes('mistral') || m.includes('mixtral')) brand = 'mistral';
  else if (m.includes('qwen')) brand = 'qwen';
  else if (m.includes('zai') || m.includes('glm') || m.includes('cerebras')) brand = 'cerebras';
  else if (m.includes('llama') || m.includes('groq')) brand = 'groq';

  const brandWeights = DEFAULT_WEIGHTS[brand] || DEFAULT_WEIGHTS.openai!;
  return brandWeights[category] || brandWeights.default || 0.80;
}

export class HalReliabilityOracle {
  /**
   * Get the weight for a given provider model and category.
   * Leverages out-of-band confusion matrices and overrides weights if drift is detected.
   */
  async getProviderWeight(model: string, category: string): Promise<number> {
    try {
      // 1. Check if model has a drift alert prompting conservative fallback in the last 24h
      const { data: driftAlert, error: alertErr } = await db
        .from('hal_canary_drift_alerts')
        .select('*')
        .eq('model_version', model)
        .eq('reverted_to_conservative', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!alertErr && driftAlert) {
        // Conservative fallback weight
        console.warn(`[ReliabilityOracle] Provider ${model} has active drift alert. Reverting to conservative weight 0.10.`);
        return 0.10;
      }

      // 2. Query weights from hal_provider_reliability
      const { data, error } = await db
        .from('hal_provider_reliability')
        .select('weight')
        .eq('model_version', model)
        .eq('category', category)
        .maybeSingle();

      if (!error && data && data.weight != null) {
        // Anti-Kingmaker: cap the weight at 0.85 so no single provider dominates
        return Math.min(Number(data.weight), 0.85);
      }
    } catch (e: any) {
      console.error(`[ReliabilityOracle] Failed to query weight for ${model}/${category}:`, e.message);
    }

    // 3. Fallback to default static weights, capped at 0.85
    return Math.min(getFallbackWeight(model, category), 0.85);
  }

  /**
   * Re-computes TP, FP, TN, FN confusion matrices and weights from validation runs.
   * Feeds validator weights directly from out-of-band ground truth (hal_test_cases).
   */
  async updateReliabilityStats(): Promise<void> {
    console.log('[ReliabilityOracle] Re-computing provider stats from validation runs...');

    // Fetch validation runs that contain individual provider verdicts
    const { data: runs, error: runsErr } = await db
      .from('hal_validation_runs')
      .select('hal_signals, test_case_id')
      .not('hal_signals', 'is', null);

    if (runsErr || !runs || runs.length === 0) {
      console.log(`[ReliabilityOracle] No runs with verdicts found. Stats update skipped.`, runsErr?.message);
      return;
    }

    // Fetch corresponding test cases
    const { data: testCases, error: tcErr } = await db
      .from('hal_test_cases')
      .select('id, category, expected_hallucination');

    if (tcErr || !testCases) {
      console.error(`[ReliabilityOracle] Failed to load test cases:`, tcErr?.message);
      return;
    }

    const tcMap = new Map(testCases.map(tc => [tc.id, tc]));

    // Accumulators grouped by model and category
    // key: "model_name|category"
    const statsMap = new Map<string, { tp: number; fp: number; tn: number; fn: number }>();

    for (const run of runs) {
      const tc = tcMap.get(run.test_case_id);
      if (!tc) continue;

      const signals = run.hal_signals as any;
      const verdicts = signals?.verdicts; // Array of ProviderVerdict: { provider, verdict, confidence, latency_ms }
      if (!Array.isArray(verdicts)) continue;

      for (const v of verdicts) {
        if (v.verdict === 'ERROR') continue;

        const modelName = v.provider; // In validation runs, provider logs the model name or family name
        const category = tc.category;
        const key = `${modelName}|${category}`;

        if (!statsMap.has(key)) {
          statsMap.set(key, { tp: 0, fp: 0, tn: 0, fn: 0 });
        }

        const stats = statsMap.get(key)!;
        const predictedFalse = v.verdict === 'FALSE';
        const expectedFalse = tc.expected_hallucination === true;

        if (expectedFalse && predictedFalse) stats.tp++;
        else if (!expectedFalse && predictedFalse) stats.fp++;
        else if (!expectedFalse && !predictedFalse) stats.tn++;
        else if (expectedFalse && !predictedFalse) stats.fn++;
      }
    }

    // Write back updated stats and F1 weights
    for (const [key, stats] of statsMap.entries()) {
      const [model, category] = key.split('|');
      if (!model || !category) continue;

      const total = stats.tp + stats.fp + stats.tn + stats.fn;
      if (total === 0) continue;

      const precision = (stats.tp + stats.fp) > 0 ? stats.tp / (stats.tp + stats.fp) : 0;
      const recall = (stats.tp + stats.fn) > 0 ? stats.tp / (stats.tp + stats.fn) : 0;
      let f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0.5;
      
      // Keep weight bounded to [0.1, 0.85] so no provider is completely zeroed out, capped to avoid a single Kingmaker
      f1 = Math.max(0.10, Math.min(0.85, f1));

      console.log(`[ReliabilityOracle] Model ${model} Category ${category}: TP=${stats.tp} FP=${stats.fp} TN=${stats.tn} FN=${stats.fn} -> F1 Weight: ${f1.toFixed(3)}`);

      const { error: upsertErr } = await db
        .from('hal_provider_reliability')
        .upsert({
          model_version: model,
          category,
          tp: stats.tp,
          fp: stats.fp,
          tn: stats.tn,
          fn: stats.fn,
          weight: f1,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'model_version,category'
        });

      if (upsertErr) {
        console.error(`[ReliabilityOracle] Failed to upsert stats for ${key}:`, upsertErr.message);
      }
    }
  }

  /**
   * Run evaluations on canary gold-cases to detect silent provider drift.
   * If accuracy falls below 85%, log alerts and flag for conservative fallback.
   */
  async checkProviderDrift(): Promise<void> {
    console.log('[ReliabilityOracle] Running canary drift check...');

    // Fetch canary gold-cases
    const { data: canaries, error: canaryErr } = await db
      .from('hal_canary_cases')
      .select('*');

    if (canaryErr || !canaries || canaries.length === 0) {
      console.log('[ReliabilityOracle] No canary gold-cases found. Drift check skipped.');
      return;
    }

    const providers = buildFactCheckProviders();
    if (providers.length === 0) {
      console.error('[ReliabilityOracle] No active fact check providers configured.');
      return;
    }

    for (const p of providers) {
      console.log(`[ReliabilityOracle] Testing canary set for provider ${p.name} (${p.model})...`);
      let correct = 0;
      
      for (const tc of canaries) {
        try {
          const res = await halService.evaluate({
            text: tc.prompt_text,
            strictness: 2
          });

          // Check if provider was used and its verdict was correct
          // Find verdict for this provider
          const pResponses = res.provider_responses as any[];
          const pr = Array.isArray(pResponses) ? pResponses.find(r => r.provider === p.name) : null;
          
          if (pr && pr.verdict !== 'ERROR') {
            const expectedVeto = tc.expected_decision === 'veto';
            const predictedVeto = pr.verdict === 'FALSE';
            if (predictedVeto === expectedVeto) {
              correct++;
            }
          } else {
            // Error count as wrong
            console.warn(`[ReliabilityOracle] Provider ${p.name} returned error or was skipped on canary #${tc.id}`);
          }
        } catch (e: any) {
          console.error(`[ReliabilityOracle] Canary evaluation failed for ${p.name} on case #${tc.id}:`, e.message);
        }
        
        // Brief pause between requests
        await new Promise(r => setTimeout(r, 400));
      }

      const accuracy = correct / canaries.length;
      console.log(`[ReliabilityOracle] Provider ${p.name} Canary Accuracy: ${(accuracy * 100).toFixed(2)}% (${correct}/${canaries.length})`);

      // Drift threshold: 85%
      if (accuracy < 0.85) {
        const msg = `Canary drift detected for ${p.name} (${p.model}): accuracy dropped to ${(accuracy * 100).toFixed(2)}% (below 85% threshold).`;
        console.warn(`[ALERT] ${msg}`);
        
        // Log alert and flag revert to conservative
        const { error: alertErr } = await db
          .from('hal_canary_drift_alerts')
          .insert({
            model_version: p.name,
            alert_message: msg,
            prior_accuracy: 0.95, // Baseline
            current_accuracy: accuracy,
            reverted_to_conservative: true
          });

        if (alertErr) {
          console.error('[ReliabilityOracle] Failed to write drift alert:', alertErr.message);
        }
      } else {
        // Resolve drift if accuracy is recovered
        const { error: resolveErr } = await db
          .from('hal_canary_drift_alerts')
          .insert({
            model_version: p.name,
            alert_message: `Accuracy recovered to ${(accuracy * 100).toFixed(2)}% on canary set. Resolving drift.`,
            prior_accuracy: accuracy,
            current_accuracy: accuracy,
            reverted_to_conservative: false
          });

        if (resolveErr) {
          console.error('[ReliabilityOracle] Failed to resolve drift alert:', resolveErr.message);
        }
      }
    }
  }
}

export const reliabilityOracle = new HalReliabilityOracle();
