import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { evaluate } from '../hal/lib';
import { HALContext, HALResult, StrictnessLevel } from '../hal/lib/types';
import { createDefaultEmbeddingClient } from '../hal/lib/cross-llm/embedding-client';
import { getHALAccuracyMetrics } from './hal-autorunner/metrics';

dotenv.config();

export class HALAutorunnerService {
  private supabase: SupabaseClient;
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private lastRunAt: Date | null = null;
  private promptsProcessedTotal: number = 0;
  private promptsProcessedLastHour: number = 0;
  private runId: string;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    this.runId = Date.now().toString();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[HAL-Autorunner] Starting service. Run ID: ${this.runId}`);
    
    // Process every 5 minutes
    this.interval = setInterval(() => this.processBatch(), 5 * 60 * 1000);
    
    // Initial run
    await this.processBatch();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
  }

  private async processBatch() {
    try {
      console.log(`[HAL-Autorunner] Processing batch at ${new Date().toISOString()}`);
      
      // 1. Get cursor
      const { data: kvData } = await this.supabase
        .from('trinity_kv_store')
        .select('value')
        .eq('key', `hal_autorunner_cursor:${this.runId}`)
        .single();
      
      const lastId = kvData?.value || '00000000-0000-0000-0000-000000000000';

      // 2. Query prompts
      const { data: prompts, error: promptError } = await this.supabase
        .from('hal_test_prompts')
        .select('*')
        .or('pilot_prompt.eq.true,human_verified.eq.true')
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(5);

      if (promptError) throw promptError;
      if (!prompts || prompts.length === 0) {
        console.log('[HAL-Autorunner] No new prompts to process.');
        this.lastRunAt = new Date();
        return;
      }

      const embeddingClient = createDefaultEmbeddingClient(process.env.VOYAGE_API_KEY);
      
      // Basic providers for cross-LLM
      const providers = [];
      if (process.env.GROQ_API_KEY) {
        providers.push({
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: process.env.GROQ_API_KEY,
          callType: 'openai-compat'
        });
      }
      if (process.env.CEREBRAS_API_KEY) {
        providers.push({
          provider: 'cerebras',
          model: 'llama3.1-8b',
          endpoint: 'https://api.cerebras.ai/v1/chat/completions',
          apiKey: process.env.CEREBRAS_API_KEY,
          callType: 'openai-compat'
        });
      }

      for (const prompt of prompts) {
        console.log(`[HAL-Autorunner] Evaluating prompt: ${prompt.prompt_id}`);
        
        const context: HALContext = {
          domain: prompt.domain,
          certainty: prompt.certainty_levels_to_test?.[0] || 0.88,
          strictness: 4 as StrictnessLevel,
          prompt: prompt.prompt_text,
          supabase: this.supabase,
          embeddingClient,
          providers: providers as any,
          classifierProvider: providers[0] as any
        };

        // In this harness, the prompt_text IS the claim.
        // We pass empty string as output because Path A extractor (repid-engine v1)
        // evaluates the claim itself.
        const result: HALResult = await evaluate(prompt.prompt_text, "", context);

        const isHallucination = prompt.category === 'factual_error';
        const wasCaught = isHallucination && result.vetoed;
        const falsePositive = !isHallucination && result.vetoed;

        // 3. Write to hal_runner_results
        await this.supabase.from('hal_runner_results').insert({
          run_id: this.runId,
          prompt_id: prompt.prompt_id,
          gen_provider: 'hal-autorunner',
          gen_model: 'v1',
          hal_mode: process.env.HAL_MODE || 'real',
          hal_score: result.hal_score,
          hal_vetoed: result.vetoed,
          comma_gap: result.signals.comma_gap,
          signals: result.signals,
          hal_diagnostics: result,
          hal_latency_ms: 0, // Not tracked in this simplified pass
          generated_answer: ""
        });

        // 4. Write to hal_threshold_sweeps
        await this.supabase.from('hal_threshold_sweeps').insert({
          run_id: this.runId,
          prompt_id: prompt.prompt_id,
          threshold_value: 0.25, // Default
          hal_vetoed: result.vetoed,
          hal_score: result.hal_score,
          is_hallucination: isHallucination,
          was_caught: wasCaught,
          false_positive: falsePositive,
          gen_provider: 'hal-autorunner',
          gen_model: 'v1'
        });

        this.promptsProcessedTotal++;
        this.promptsProcessedLastHour++;
        
        // 5. Update cursor
        await this.supabase
          .from('trinity_kv_store')
          .upsert({ key: `hal_autorunner_cursor:${this.runId}`, value: prompt.id });
      }

      this.lastRunAt = new Date();
    } catch (e: any) {
      console.error(`[HAL-Autorunner] Batch failed: ${e.message}`);
    }
  }

  async getMetrics() {
    return await getHALAccuracyMetrics();
  }

  getStats() {
    return {
      lastRunAt: this.lastRunAt,
      promptsProcessedTotal: this.promptsProcessedTotal,
      promptsProcessedLastHour: this.promptsProcessedLastHour,
      runId: this.runId
    };
  }
}
