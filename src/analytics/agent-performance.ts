import { db } from '../db';

export interface AgentPerformance {
  agent_name: string;
  period: '1h' | '24h' | '7d' | '30d';
  
  // Throughput
  tasks_completed: number;
  tasks_failed: number;
  tasks_shadow_rejected: number;
  completion_rate: number;
  
  // Quality
  hal_catch_rate: number;
  false_positive_rate: number;
  peer_agreement_rate: number;
  
  // Efficiency
  avg_latency_ms: number;
  avg_tokens_per_task: number;
  avg_cost_per_task: number;
  free_tier_usage_pct: number;
  
  // Learning
  improvement_trend: number;
  domains_strongest: string[];
  domains_weakest: string[];
  escalation_rate: number;
}

const PERIOD_MAP = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export async function getAgentPerformance(
  agentName: string,
  periodKey: '1h' | '24h' | '7d' | '30d' = '24h'
): Promise<AgentPerformance> {
  const periodVal = PERIOD_MAP[periodKey];

  // 1. Call DB performance function
  const { data: dbData, error: dbErr } = await db.rpc('fn_agent_performance', {
    p_agent_name: agentName,
    p_period: periodVal,
  });

  if (dbErr) {
    throw new Error(`Database RPC fn_agent_performance failed: ${dbErr.message}`);
  }

  const baseStats = dbData as any;

  // Resolve agent UUID for other queries
  const { data: agentRow } = await db
    .from('repid_agents')
    .select('id')
    .eq('agent_name', agentName)
    .maybeSingle();

  const agentId = agentRow?.id;

  let avgTokens = 0;
  let freeTierPct = 0;
  let trend = 0.0;
  let strongest: string[] = [];
  let weakest: string[] = [];

  if (agentId) {
    // 2. Query tokens & free tier usage from llm_call_log
    const { data: llmData } = await db
      .from('llm_call_log')
      .select('total_tokens, tier')
      .eq('agent_id', agentId)
      .gt('created_at', new Date(Date.now() - getPeriodMs(periodKey)).toISOString());

    if (llmData && llmData.length > 0) {
      const totalTokens = llmData.reduce((acc, row) => acc + (row.total_tokens || 0), 0);
      avgTokens = Math.round(totalTokens / llmData.length);

      const freeCalls = llmData.filter(row => row.tier === '0a' || row.tier === 'free').length;
      freeTierPct = Math.round((freeCalls * 100) / llmData.length);
    }

    // 3. Learning Trend (compare current vs previous period completion_rate)
    const prevPeriodVal = getPreviousPeriodInterval(periodKey);
    const { data: prevDbData } = await db.rpc('fn_agent_performance', {
      p_agent_name: agentName,
      p_period: prevPeriodVal,
    });
    
    if (prevDbData) {
      const currentRate = baseStats.completion_rate || 0;
      const prevRate = (prevDbData as any).completion_rate || 0;
      trend = Math.round((currentRate - prevRate) * 10) / 10;
    }

    // 4. Domains (strongest & weakest) from repid_score_events task_domain
    const { data: domainData } = await db
      .from('repid_score_events')
      .select('task_domain, hal_decision')
      .eq('agent_id', agentId)
      .not('task_domain', 'is', null)
      .gt('created_at', new Date(Date.now() - getPeriodMs(periodKey)).toISOString());

    if (domainData && domainData.length > 0) {
      const domainStats: Record<string, { total: number; vetoed: number }> = {};
      for (const row of domainData) {
        const dom = row.task_domain;
        if (!domainStats[dom]) domainStats[dom] = { total: 0, vetoed: 0 };
        domainStats[dom].total++;
        if (row.hal_decision === 'vetoed') domainStats[dom].vetoed++;
      }

      for (const [dom, stats] of Object.entries(domainStats)) {
        const vetoRate = stats.vetoed / stats.total;
        if (vetoRate < 0.15) {
          strongest.push(dom);
        } else if (vetoRate > 0.4) {
          weakest.push(dom);
        }
      }
    }
  }

  // Set default fallback domains if none found
  if (strongest.length === 0) strongest = ['factual_verification'];
  if (weakest.length === 0) weakest = ['code_review'];

  return {
    agent_name: agentName,
    period: periodKey,
    tasks_completed: baseStats.tasks_completed || 0,
    tasks_failed: baseStats.tasks_failed || 0,
    tasks_shadow_rejected: baseStats.tasks_shadow_rejected || 0,
    completion_rate: baseStats.completion_rate || 0,
    hal_catch_rate: baseStats.hal_catch_rate || 0,
    false_positive_rate: baseStats.false_positive_rate || 0,
    peer_agreement_rate: baseStats.peer_agreement_rate || 0,
    avg_latency_ms: baseStats.avg_latency_ms || 0,
    avg_tokens_per_task: avgTokens,
    avg_cost_per_task: baseStats.avg_cost_usd || 0,
    free_tier_usage_pct: freeTierPct,
    improvement_trend: trend,
    domains_strongest: strongest,
    domains_weakest: weakest,
    escalation_rate: baseStats.escalation_rate || 0,
  };
}

function getPeriodMs(period: '1h' | '24h' | '7d' | '30d'): number {
  switch (period) {
    case '1h': return 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
  }
}

function getPreviousPeriodInterval(period: '1h' | '24h' | '7d' | '30d'): string {
  switch (period) {
    case '1h': return '2 hours';
    case '24h': return '48 hours';
    case '7d': return '14 days';
    case '30d': return '60 days';
  }
}

export async function getAgentsLeaderboard(
  periodKey: '1h' | '24h' | '7d' | '30d' = '24h'
): Promise<any[]> {
  const { data: agents, error } = await db
    .from('repid_agents')
    .select('agent_name')
    .neq('agent_name', 'HUMAN');

  if (error || !agents) return [];

  const list = await Promise.all(
    agents.map(async (a: any) => {
      try {
        const perf = await getAgentPerformance(a.agent_name, periodKey);
        const comp = perf.completion_rate / 100;
        const catchRate = perf.hal_catch_rate / 100;
        const esc = perf.escalation_rate / 100;
        const cost = Math.min(perf.avg_cost_per_task, 1.0);
        
        const score = (comp * 0.3) + (catchRate * 0.3) + (1 - esc) * 0.2 + (1 - cost) * 0.2;
        return {
          ...perf,
          weighted_score: Math.round(score * 1000) / 10,
        };
      } catch (err) {
        return null;
      }
    })
  );

  return list
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.weighted_score - a.weighted_score);
}

