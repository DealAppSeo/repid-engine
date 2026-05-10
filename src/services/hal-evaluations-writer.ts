import crypto from 'crypto';
import { execSync } from 'child_process';
import { db } from '../db';

/**
 * Cached repid_engine_commit SHA. 
 * Captured at module load to avoid repeated exec calls.
 */
let CACHED_COMMIT_SHA: string | undefined;
try {
  CACHED_COMMIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || 
                     process.env.GIT_SHA || 
                     execSync('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
} catch (e) {
  CACHED_COMMIT_SHA = 'unknown';
}

export interface HalEvaluationParams {
  mode: 'production' | 'calibration' | 'backtest' | 'shadow' | 'a_b';
  experiment_id?: string;
  corpus_version?: string;
  threshold_set_version?: string;
  hal_mode?: string;
  hyperdag_bench_commit?: string;
  manifest_dataset_id?: string;
  prompt_id?: string;
  prompt_source?: 'production_traffic' | 'truthfulqa' | 'hal_test_prompts' | 'live_user_query';
  prompt_text?: string;
  agent_id?: string;
  api_key?: string;
  gen_provider?: string;
  gen_model?: string;
  gen_latency_ms?: number;
  hal_signals?: any;
  certainty_used?: number;
  hal_score?: number;
  comma_gap?: number;
  hal_vetoed?: boolean;
  decision?: 'APPROVE' | 'HITL' | 'BLOCK' | 'VETO';
  ground_truth_label?: string;
  was_caught?: boolean;
  false_positive?: boolean;
  repid_delta?: number;
  cost_usd?: number;
  parent_evaluation_id?: string;
  notes?: string;
}

/**
 * Dual-write a hal_evaluations row alongside the existing 
 * hal_classifications write. Mode-tagged for the unified 
 * evaluation architecture.
 * 
 * Behavior is gated by env var HAL_EVALUATIONS_DUAL_WRITE.
 * Defaults OFF — function returns immediately if not 'true'.
 * 
 * Errors here MUST NOT propagate. Log a warning and return.
 */
export async function writeHalEvaluation(params: HalEvaluationParams): Promise<void> {
  if (process.env.HAL_EVALUATIONS_DUAL_WRITE !== 'true') {
    return;
  }

  try {
    const prompt_text_hash = params.prompt_text 
      ? crypto.createHash('sha256').update(params.prompt_text).digest('hex')
      : undefined;
    
    const api_key_hash = params.api_key
      ? crypto.createHash('sha256').update(params.api_key).digest('hex')
      : undefined;

    const payload: any = {
      mode: params.mode,
      experiment_id: params.experiment_id,
      corpus_version: params.corpus_version,
      threshold_set_version: params.threshold_set_version,
      hal_mode: params.hal_mode,
      hyperdag_bench_commit: params.hyperdag_bench_commit,
      repid_engine_commit: CACHED_COMMIT_SHA,
      manifest_dataset_id: params.manifest_dataset_id,
      prompt_id: params.prompt_id,
      prompt_source: params.prompt_source,
      prompt_text_hash,
      agent_id: params.agent_id,
      api_key_hash,
      gen_provider: params.gen_provider,
      gen_model: params.gen_model,
      gen_latency_ms: params.gen_latency_ms,
      hal_signals: params.hal_signals,
      certainty_used: params.certainty_used,
      hal_score: params.hal_score,
      comma_gap: params.comma_gap,
      hal_vetoed: params.hal_vetoed,
      decision: params.decision,
      ground_truth_label: params.ground_truth_label,
      was_caught: params.was_caught,
      false_positive: params.false_positive,
      repid_delta: params.repid_delta,
      cost_usd: params.cost_usd,
      parent_evaluation_id: params.parent_evaluation_id,
      notes: params.notes
    };

    // Use the existing db client from ../db
    const { error } = await db.from('hal_evaluations').insert(payload);
    
    if (error) {
      console.warn('[hal-evaluations-writer] insert failed:', error.message);
    }
  } catch (e: any) {
    console.warn('[hal-evaluations-writer] unexpected error:', e?.message ?? e);
  }
}
