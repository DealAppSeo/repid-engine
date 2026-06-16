import { db as supabase } from '../db';
import type { FactCheckResult } from '../hal/fact-check';

export type HitlReason =
  | 'judge_escalated'
  | 'pcp_low_confidence'
  | 'judge_pcp_disagreement'
  | 'manual_review'
  | 'timeout_escalation'
  | 'hal_score_above_threshold'   // HAL score crossed hal_hitl_threshold (async human auditor)
  | 'sbfa_escalate'               // SBFA decision = 'escalate' (contested panel, needs human)
  | 'sbfa_abstain';               // SBFA decision = 'abstain' (no checkable claim, human review)

export type HitlResolution =
  | 'approve_claimer'
  | 'challenge_claimer'
  | 'rework_required'
  | 'no_action';

export type HitlStatus =
  | 'pending'
  | 'assigned'
  | 'reviewing'
  | 'resolved'
  | 'expired'
  | 'cancelled';

export interface HitlContext {
  pcpScore?: number;
  pcpConfidence?: number;
  judgeVerdict?: string;
  judgeConfidence?: number;
  validatorAgents?: string[];
  taskSnapshot?: Record<string, unknown>;
  workerVerdictPreHitl?: string;
  /**
   * GLASS BOX — SBFA v0.2 belief/ignorance/confidence + structured decision trace.
   * Populated by the escalation-trace-producer (feat/cc-2026-06-16) when a HAL/SBFA
   * decision crosses the human-trigger threshold (hal_hitl_threshold).
   * The controller-pwa Glass Box renderer reads request.context?.sbfa (or .sbfa_trace).
   */
  sbfa?: FactCheckResult['sbfa'];
}

export interface HitlRequest {
  id: string;
  taskId: number;
  validationQueueId: string | null;
  requestReason: HitlReason;
  requestContext: HitlContext;
  status: HitlStatus;
  priority: number;
  assignedTo: string | null;
  resolution: HitlResolution | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  expiresAt: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export class HitlService {
  async createRequest(params: {
    taskId: number;
    validationQueueId: string | null;
    reason: HitlReason;
    context: HitlContext;
    priority?: number;
  }): Promise<{ id: string; created: boolean }> {
    // Before INSERT, SELECT existing rows matching (task_id, validation_queue_id, request_reason)
    const { data: existing } = await supabase
      .from('hitl_requests')
      .select('id')
      .eq('task_id', params.taskId)
      .eq('validation_queue_id', params.validationQueueId || null)
      .eq('request_reason', params.reason)
      .in('status', ['pending', 'assigned', 'reviewing'])
      .maybeSingle();

    if (existing) {
      return { id: existing.id, created: false };
    }

    // If not found: INSERT
    const { data: inserted, error } = await supabase
      .from('hitl_requests')
      .insert({
        task_id: params.taskId,
        validation_queue_id: params.validationQueueId,
        request_reason: params.reason,
        request_context: params.context as unknown as Record<string, unknown>,
        priority: params.priority || 5
      })
      .select('id')
      .single();

    if (error) {
      // Catch unique violation race condition (23505)
      if (error.code === '23505') {
        const { data: reSelected } = await supabase
          .from('hitl_requests')
          .select('id')
          .eq('task_id', params.taskId)
          .eq('validation_queue_id', params.validationQueueId || null)
          .eq('request_reason', params.reason)
          .in('status', ['pending', 'assigned', 'reviewing'])
          .single();
        
        if (reSelected) {
          return { id: reSelected.id, created: false };
        }
      }
      throw new Error(`Failed to create HITL request: ${error.message}`);
    }

    return { id: inserted.id, created: true };
  }

  async assignRequest(params: {
    requestId: string;
    reviewer: string;
  }): Promise<HitlRequest> {
    const { data, error } = await supabase
      .from('hitl_requests')
      .update({ assigned_to: params.reviewer, status: 'assigned' })
      .eq('id', params.requestId)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !data) {
      throw new Error(`HITL request ${params.requestId} could not be assigned (already claimed or missing)`);
    }

    return this.mapToCamelCase(data);
  }

  async resolveRequest(params: {
    requestId: string;
    resolution: HitlResolution;
    notes?: string;
    reviewer: string;
  }): Promise<HitlRequest> {
    const { data, error } = await supabase
      .from('hitl_requests')
      .update({
        status: 'resolved',
        resolution: params.resolution,
        resolved_at: new Date().toISOString(),
        resolution_notes: params.notes || null
      })
      .eq('id', params.requestId)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to resolve HITL request ${params.requestId}: ${error?.message || 'Not found'}`);
    }

    // Write to hal_audit_chain
    await supabase.rpc('append_hal_audit_chain', {
      p_source_table: 'hitl_requests',
      p_source_id: params.requestId,
      p_event_payload: {
        resolution: params.resolution,
        reviewer: params.reviewer,
        validation_queue_id: data.validation_queue_id
      },
      p_canonical_json_text: JSON.stringify({ resolution: params.resolution, reviewer: params.reviewer })
    });

    return this.mapToCamelCase(data);
  }

  async expireStaleRequests(): Promise<{ expired: number; expiredIds: string[] }> {
    const { data, error } = await supabase
      .from('hitl_requests')
      .update({ status: 'expired' })
      .lt('expires_at', new Date().toISOString())
      .in('status', ['pending', 'assigned', 'reviewing'])
      .select('id');

    if (error) {
      throw new Error(`Failed to expire stale requests: ${error.message}`);
    }

    return {
      expired: data?.length || 0,
      expiredIds: data?.map(row => row.id) || []
    };
  }

  async getPendingRequests(opts?: {
    limit?: number;
    minPriority?: number;
  }): Promise<HitlRequest[]> {
    let query = supabase
      .from('hitl_requests')
      .select('*')
      .eq('status', 'pending');

    if (opts?.minPriority) {
      query = query.gte('priority', opts.minPriority);
    }

    query = query.order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(opts?.limit || 50);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch pending requests: ${error.message}`);
    }

    return (data || []).map(row => this.mapToCamelCase(row));
  }

  async getRequest(id: string): Promise<HitlRequest | null> {
    const { data, error } = await supabase
      .from('hitl_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch HITL request ${id}: ${error.message}`);
    return data ? this.mapToCamelCase(data) : null;
  }

  private mapToCamelCase(row: any): HitlRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      validationQueueId: row.validation_queue_id,
      requestReason: row.request_reason,
      requestContext: row.request_context,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to,
      resolution: row.resolution,
      resolutionNotes: row.resolution_notes,
      resolvedAt: row.resolved_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      metadata: row.metadata
    };
  }
}

export const hitlService = new HitlService();
