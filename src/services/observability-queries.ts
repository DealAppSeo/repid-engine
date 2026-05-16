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
    .select('passed, gate_type, status')
    .gte('created_at', oneDayAgo)
    .limit(10000);
    
  const status: SubstanceGateStatus = {
    eventsLast24h: data?.length || 0,
    passRate: 0,
    failBySubtype: {},
    shadowRejectCount: 0
  };
  
  if (data && data.length > 0) {
    const passed = data.filter(d => d.passed).length;
    status.passRate = passed / data.length;
    status.shadowRejectCount = data.filter(d => d.status === 'shadow_reject').length;
    data.filter(d => !d.passed).forEach(d => {
      status.failBySubtype[d.gate_type] = (status.failBySubtype[d.gate_type] || 0) + 1;
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
    db.from('hitl_requests').select('id').eq('status', 'expired').gte('updated_at', sevenDaysAgo) // Assuming standard updated_at exists or we can just count
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
