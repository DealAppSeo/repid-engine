import { db } from '../db';
import { HitlReason } from './hitl-service';

export interface ValidationQueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  escalated: number;
  avgAgeSeconds: number;
  oldestPendingAgeSeconds: number;
}

export interface SubstanceGateStatus {
  eventsLast24h: number;
  passRate: number;
  failBySubtype: Record<string, number>;
  shadowRejectCount: number;
}

export interface HitlStatusSummary {
  pending: number;
  assigned: number;
  reviewing: number;
  resolvedLast24h: number;
  avgResolutionHours: number;
  expiredLast7d: number;
  byReason: Record<HitlReason, number>;
}

export interface AgentStatusRow {
  agentName: string;
  lastPing: string;
  healthy: boolean;
  repid: number | null;
  tasksClaimed24h: number;
  validationsPerformed24h: number;
  validationAccuracy30d: number | null;
}

export interface RepidEventStats {
  eventsLast24hByType: Record<string, number>;
  deltaSumLast24h: number;
  claimersSlashed24h: number;
  validatorsRewarded24h: number;
}

export async function getValidationQueueStatus(): Promise<ValidationQueueStatus> {
  const { data, error } = await db.rpc('get_validation_queue_status_24h');
  if (!error && data) return data as ValidationQueueStatus;
  
  // Fallback if RPC doesn't exist yet
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data: raw } = await db.from('validation_queue')
    .select('status, created_at')
    .gte('created_at', oneDayAgo)
    .limit(10000); // safety
    
  const summary: ValidationQueueStatus = {
    pending: 0, processing: 0, completed: 0, failed: 0, escalated: 0,
    avgAgeSeconds: 0, oldestPendingAgeSeconds: 0
  };
  
  if (raw) {
    let pendingAgeSum = 0;
    raw.forEach(r => {
      const statusKey = r.status as keyof ValidationQueueStatus;
      if (summary[statusKey] !== undefined) {
        (summary as any)[statusKey]++;
      }
      if (r.status === 'pending') {
        const ageSecs = (Date.now() - new Date(r.created_at).getTime()) / 1000;
        pendingAgeSum += ageSecs;
        if (ageSecs > summary.oldestPendingAgeSeconds) summary.oldestPendingAgeSeconds = ageSecs;
      }
    });
    if (summary.pending > 0) summary.avgAgeSeconds = pendingAgeSum / summary.pending;
  }
  return summary;
}

export async function getSubstanceGateStatus(): Promise<SubstanceGateStatus> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data } = await db.from('substance_gate_events')
    .select('passed, failure_reasons')
    .gte('created_at', oneDayAgo)
    .limit(10000);
    
  const status: SubstanceGateStatus = {
    eventsLast24h: data?.length || 0,
    passRate: 0,
    failBySubtype: {},
    shadowRejectCount: 0 // Stubbed: 'status' column does not exist on substance_gate_events
  };
  
  if (data && data.length > 0) {
    const passed = data.filter(d => d.passed).length;
    status.passRate = passed / data.length;
    data.filter(d => !d.passed).forEach(d => {
      // Assuming failure_reasons is an array of strings
      const reasons = d.failure_reasons as string[] || ['unknown'];
      reasons.forEach(r => {
        status.failBySubtype[r] = (status.failBySubtype[r] || 0) + 1;
      });
    });
  }
  return status;
}

export async function getHitlStatus(): Promise<HitlStatusSummary> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  
  const [active, resolved, expired] = await Promise.all([
    db.from('hitl_requests').select('status, request_reason').in('status', ['pending', 'assigned', 'reviewing']),
    db.from('hitl_requests').select('created_at, resolved_at').eq('status', 'resolved').gte('resolved_at', oneDayAgo),
    db.from('hitl_requests').select('id').eq('status', 'expired').gte('expires_at', sevenDaysAgo)
  ]);

  const status: HitlStatusSummary = {
    pending: 0, assigned: 0, reviewing: 0, resolvedLast24h: resolved.data?.length || 0,
    avgResolutionHours: 0, expiredLast7d: expired.data?.length || 0, byReason: {} as Record<HitlReason, number>
  };

  if (active.data) {
    active.data.forEach(r => {
      if (r.status === 'pending') status.pending++;
      if (r.status === 'assigned') status.assigned++;
      if (r.status === 'reviewing') status.reviewing++;
      const reason = r.request_reason as HitlReason;
      status.byReason[reason] = (status.byReason[reason] || 0) + 1;
    });
  }
  
  if (resolved.data && resolved.data.length > 0) {
    let sumHrs = 0;
    resolved.data.forEach(r => {
      if (r.resolved_at && r.created_at) {
        sumHrs += (new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime()) / 3600000;
      }
    });
    status.avgResolutionHours = sumHrs / resolved.data.length;
  }
  return status;
}

export async function getAgentStatus(): Promise<AgentStatusRow[]> {
  const { data } = await db.from('agent_heartbeat')
    .select('agent_name, last_ping, tasks_completed_session')
    .limit(100);
  
  return (data || []).map(r => {
    const ageSecs = (Date.now() - new Date(r.last_ping).getTime()) / 1000;
    return {
      agentName: r.agent_name,
      lastPing: r.last_ping,
      healthy: ageSecs < 120, // 2 mins
      repid: null, // Stubbed for Phase 2.7
      tasksClaimed24h: r.tasks_completed_session || 0,
      validationsPerformed24h: 0,
      validationAccuracy30d: null
    };
  });
}

export async function getRepidEventStats(): Promise<RepidEventStats> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data } = await db.from('repid_score_events')
    .select('event_type, delta')
    .gte('created_at', oneDayAgo)
    .limit(10000);
    
  const stats: RepidEventStats = {
    eventsLast24hByType: {},
    deltaSumLast24h: 0,
    claimersSlashed24h: 0,
    validatorsRewarded24h: 0
  };
  
  if (data) {
    data.forEach(r => {
      stats.eventsLast24hByType[r.event_type] = (stats.eventsLast24hByType[r.event_type] || 0) + 1;
      stats.deltaSumLast24h += (r.delta || 0);
      if (r.event_type === 'VALIDATOR_REWARD') stats.validatorsRewarded24h++;
      if (r.event_type === 'VALIDATION_FAILED' || r.event_type === 'CHALLENGE_LOSS') stats.claimersSlashed24h++;
    });
  }
  return stats;
}

export interface PeerVerificationStats {
  peer_verification_rate: number;
  peer_verification_agreement_rate: number;
  peer_verification_latency_p50: number;
  peer_verification_latency_p95: number;
  total_in_queue: number;
  pending_count: number;
  in_review_count: number;
  completed_count: number;
}

export async function getPeerVerificationStats(): Promise<PeerVerificationStats> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();

  // 1. Fetch total events in last 24h
  const { count: totalEvents } = await db
    .from('repid_score_events')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', oneDayAgo);

  // 2. Fetch queue stats in last 24h
  const { data: queueEntries } = await db
    .from('peer_verification_queue')
    .select('verification_status, created_at, completed_at, verifier_signature')
    .gte('created_at', oneDayAgo);

  const stats: PeerVerificationStats = {
    peer_verification_rate: 0,
    peer_verification_agreement_rate: 0,
    peer_verification_latency_p50: 0,
    peer_verification_latency_p95: 0,
    total_in_queue: queueEntries?.length || 0,
    pending_count: 0,
    in_review_count: 0,
    completed_count: 0
  };

  if (queueEntries && queueEntries.length > 0) {
    if (totalEvents && totalEvents > 0) {
      stats.peer_verification_rate = queueEntries.length / totalEvents;
    }

    const completed = queueEntries.filter(e => e.verification_status === 'verified' || e.verification_status === 'disputed');
    stats.completed_count = completed.length;
    stats.pending_count = queueEntries.filter(e => e.verification_status === 'pending').length;
    stats.in_review_count = queueEntries.filter(e => e.verification_status === 'in_review').length;

    if (completed.length > 0) {
      const verified = completed.filter(e => e.verification_status === 'verified').length;
      stats.peer_verification_agreement_rate = verified / completed.length;

      // Calculate latencies
      const latencies = completed
        .map(e => {
          if (e.completed_at && e.created_at) {
            return (new Date(e.completed_at).getTime() - new Date(e.created_at).getTime()) / 1000;
          }
          return null;
        })
        .filter((l): l is number => l !== null)
        .sort((a, b) => a - b);

      if (latencies.length > 0) {
        const p50Idx = Math.floor(latencies.length * 0.5);
        const p95Idx = Math.floor(latencies.length * 0.95);
        stats.peer_verification_latency_p50 = latencies[p50Idx] ?? 0;
        stats.peer_verification_latency_p95 = latencies[Math.min(p95Idx, latencies.length - 1)] ?? 0;
      }
    }
  }

  return stats;
}

export async function getLlmRoutingStats(windowDays: number = 7): Promise<any> {
  // PHASE2: surface from llm_call_log (free-first now provable post instrumentation).
  // Provider/model usage, free (tier0a) vs paid split, total cost, counts. Matches DONE-CHECK GROUP BY provider count/sum(cost_usd).
  // Cite: SPRINT_XC_2026-06-05.md:18 (P2.1 + DONE-CHECK), route.ts logLlmCall (provider/tier/cost_usd), observability.ts /status/routing (mounted /api/v1/status/routing via v1.ts:29).
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const { data: rows, error } = await db
    .from('llm_call_log')
    .select('provider, tier, model, cost_usd, latency_ms, status, created_at, prompt_tokens, completion_tokens')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50000); // tolerant; for prod use agg or rpc

  if (error) {
    // tolerant for BLOCKED/no rows
    return { total_calls: 0, note: 'llm_call_log query failed or empty (BLOCKED creds or no data)', error: error.message };
  }
  const calls = rows || [];

  const total_calls = calls.length;
  const total_cost = calls.reduce((s, r: any) => s + (Number(r.cost_usd) || 0), 0);
  const free_calls = calls.filter((r: any) => (r.tier || '').includes('0') || (r.tier || '') === '0a').length;
  const paid_calls = total_calls - free_calls;
  const free_cost = calls.filter((r: any) => (r.tier || '').includes('0') || (r.tier || '') === '0a').reduce((s, r: any) => s + (Number(r.cost_usd) || 0), 0);
  const paid_cost = total_cost - free_cost;

  // group by provider
  const byProvider: Record<string, { count: number; cost: number; avg_lat: number }> = {};
  for (const r of calls) {
    const p = r.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { count: 0, cost: 0, avg_lat: 0 };
    byProvider[p].count++;
    byProvider[p].cost += Number(r.cost_usd) || 0;
    byProvider[p].avg_lat += Number(r.latency_ms) || 0;
  }
  for (const p of Object.keys(byProvider)) {
    const b = byProvider[p]!;
    b.avg_lat = b.count > 0 ? Math.round(b.avg_lat / b.count) : 0;
    b.cost = Math.round(b.cost * 100000) / 100000;
  }

  // simple model usage sample (top)
  const modelCounts: Record<string, number> = {};
  for (const r of calls) {
    const m = r.model || 'unknown';
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  }

  const free_first_pct = total_calls > 0 ? Math.round((free_calls / total_calls) * 1000) / 10 : 0;

  return {
    window_days: windowDays,
    total_calls,
    total_cost_usd: Math.round(total_cost * 100000) / 100000,
    free_first_pct,
    free_calls,
    paid_calls,
    free_cost_usd: Math.round(free_cost * 100000) / 100000,
    paid_cost_usd: Math.round(paid_cost * 100000) / 100000,
    by_provider: byProvider,
    top_models: Object.entries(modelCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([m,c])=>({model:m, count:c})),
    note: 'free-first provable from llm_call_log (tier 0a = groq/cerebras/gemini/cohere/deepseek + slm). Matches SELECT provider,count(*),sum(cost_usd) GROUP BY.',
    recent_sample: calls.slice(0, 3)
  };
}
