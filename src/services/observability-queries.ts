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

export interface SquadObservabilityStats {
  squads_active_count: number;
  on_chain_attestation_reduction_rate: number;
  cross_squad_verification_rate: number;
  rep_id_provenance_coverage: number;
}

export async function getSquadObservabilityStats(): Promise<SquadObservabilityStats> {
  const { data: memberships } = await db
    .from('squad_membership')
    .select('squad_id')
    .is('left_at', null);

  const activeSquadIds = new Set((memberships || []).map((m: any) => m.squad_id).filter(Boolean));
  const squads_active_count = activeSquadIds.size;

  const { count: offChainCount } = await db
    .from('squad_internal_attestations')
    .select('id', { count: 'exact', head: true });

  const { count: totalScoreEvents } = await db
    .from('repid_score_events')
    .select('id', { count: 'exact', head: true });

  const totalOffChain = offChainCount || 0;
  const totalOnChain = totalScoreEvents || 0;
  const totalAttestations = totalOffChain + totalOnChain;
  const on_chain_attestation_reduction_rate = totalAttestations > 0 
    ? totalOffChain / totalAttestations 
    : 0.0;

  const { data: tasks } = await db
    .from('trinity_tasks')
    .select('assigned_to, metadata')
    .eq('task_type', 'peer_verify')
    .order('created_at', { ascending: false })
    .limit(100);

  let crossSquadCount = 0;
  let squadClaimCount = 0;

  if (tasks && tasks.length > 0) {
    const { data: agents } = await db
      .from('repid_agents')
      .select('id, agent_name, squad_id');

    const nameToSquad = new Map<string, string | null>();
    const idToSquad = new Map<string, string | null>();

    if (agents) {
      agents.forEach((a: any) => {
        if (a.agent_name) nameToSquad.set(a.agent_name.toLowerCase().trim(), a.squad_id);
        if (a.id) idToSquad.set(a.id, a.squad_id);
      });
    }

    tasks.forEach((t: any) => {
      const srcId = t.metadata?.source_agent_id;
      const verifierName = t.assigned_to?.toLowerCase().trim();

      if (srcId && verifierName) {
        const srcSquadId = idToSquad.get(srcId);
        const verifierSquadId = nameToSquad.get(verifierName);

        if (srcSquadId) {
          squadClaimCount++;
          if (verifierSquadId && verifierSquadId !== srcSquadId) {
            crossSquadCount++;
          }
        }
      }
    });
  }

  const cross_squad_verification_rate = squadClaimCount > 0
    ? crossSquadCount / squadClaimCount
    : 1.0;

  const { count: provenanceCount } = await db
    .from('rep_id_provenance')
    .select('id', { count: 'exact', head: true });

  const totalProv = provenanceCount || 0;
  const rep_id_provenance_coverage = totalOnChain > 0
    ? Math.min(1.0, totalProv / totalOnChain)
    : 1.0;

  return {
    squads_active_count,
    on_chain_attestation_reduction_rate,
    cross_squad_verification_rate,
    rep_id_provenance_coverage,
  };
}
