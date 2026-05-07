import { db } from '../db';

export interface CapStatus {
  allowed: boolean;
  monthly_limit: number;
  current_spent: number;
  hard_disabled: boolean;
}

export async function checkCap(provider: string): Promise<CapStatus> {
  const supabase = db;
  const { data, error } = await supabase
    .from('llm_provider_caps')
    .select('monthly_limit_usd, current_month_spent_usd, hard_disabled')
    .eq('provider', provider)
    .single();

  if (error || !data) {
    return { allowed: true, monthly_limit: 0, current_spent: 0, hard_disabled: false };
  }

  if (data.hard_disabled) {
    return { allowed: false, monthly_limit: Number(data.monthly_limit_usd), current_spent: Number(data.current_month_spent_usd), hard_disabled: true };
  }

  const limit = Number(data.monthly_limit_usd);
  const spent = Number(data.current_month_spent_usd);

  if (limit > 0 && spent >= limit) {
    await supabase.from('llm_provider_caps').update({ hard_disabled: true }).eq('provider', provider);
    return { allowed: false, monthly_limit: limit, current_spent: spent, hard_disabled: true };
  }

  return { allowed: true, monthly_limit: limit, current_spent: spent, hard_disabled: false };
}

export async function incrementSpend(provider: string, costUsd: number): Promise<void> {
  if (costUsd <= 0) return;
  const supabase = db;
  await supabase.rpc('increment_provider_spend', { p_name: provider, amount: costUsd });
}
