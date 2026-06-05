import { db } from '../db';

export interface LlmCallEntry {
  call_id: string;
  provider: string;
  tier: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: 'success' | 'failed' | 'rate_limited' | 'cap_hit';
  error_message?: string;
  user_id?: string;
  agent_id?: string;
  task_hint?: string;
  quorum_id?: string; // R5 — groups the provider calls of one HAL fact-check quorum
}

export async function logLlmCall(entry: LlmCallEntry): Promise<void> {
  try {
    const supabase = db;
    const { error } = await supabase.from('llm_call_log').insert(entry);
    if (error) {
      console.error('[Billing] Supabase error logging LLM call:', error);
    }
  } catch (error) {
    console.error('[Billing] Failed to log LLM call:', error);
  }
}
