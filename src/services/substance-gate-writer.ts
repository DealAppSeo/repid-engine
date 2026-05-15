import { SupabaseClient } from '@supabase/supabase-js';

// The FastPathResult matches the structure from trinity-symphony-shared
export interface FastPathResult {
  passed: boolean;
  failures: string[];
  composite_score: number;
  signals: {
    chars: { passed: boolean; value: number };
    wrapper: { passed: boolean };
    artifact: { passed: boolean };
    noop: { passed: boolean };
  };
}

export async function recordGateEvent(db: SupabaseClient, task: any, fastResult: FastPathResult, agentName: string) {
  try {
    const { data, error } = await db.from('substance_gate_events').insert({
      task_id: task.id,
      agent_name: agentName,
      char_count: fastResult.signals.chars.value,
      result_excerpt: (task.result || '').substring(0, 500),
      content_hash: 'computed_in_agent_or_omitted_here', // Actually, the agent computes it, we can recompute or pass it
      signal_char_passed: fastResult.signals.chars.passed,
      signal_wrapper_passed: fastResult.signals.wrapper.passed,
      signal_artifact_passed: fastResult.signals.artifact.passed,
      signal_noop_passed: fastResult.signals.noop.passed,
      passed: fastResult.passed,
      failure_reasons: fastResult.failures,
      composite_score: fastResult.composite_score,
      task_tier: task.metadata?.test_tier || 'T0_INTERNAL_DEV_TEST',
      reap_count: task.metadata?.reap_count || 0,
      metadata: task.metadata || {}
    }).select('id').single();

    if (error) throw error;
    return data.id;
  } catch (error: any) {
    console.error('[GateWriter] Error recording gate event:', error.message);
    return null;
  }
}

export async function slashRepIDForGateFail(db: SupabaseClient, agentName: string, taskId: string | number, reapCount: number, gateEventId: string) {
  // -50 for first offense, -150 if reap count > 3
  const delta = reapCount > 3 ? -150 : -50;

  // We write to repid_score_events
  try {
    const { error } = await db.from('repid_score_events').insert({
      agent_id: agentName, // agent_id is agent_name in RepID
      event_type: 'EPISTEMIC_VIOLATION',
      delta: delta,
      metadata: {
        failure_subtype: 'substance_gate_fast_path',
        fast_path_failure: true,
        task_id: taskId,
        reap_count: reapCount,
        gate_event_id: gateEventId
      }
    });

    if (error) throw error;
  } catch (error: any) {
    console.error('[GateWriter] Error slashing RepID:', error.message);
  }
  return delta;
}

export async function appendGateAuditChain(db: SupabaseClient, gateEventId: string, task: any, fastResult: FastPathResult, agentName: string) {
  const payload = {
    task_id: task.id,
    agent_name: agentName,
    passed: fastResult.passed,
    failure_reasons: fastResult.failures,
    composite_score: fastResult.composite_score,
    char_count: fastResult.signals.chars.value,
    test_tier: task.metadata?.test_tier || 'T0_INTERNAL_DEV_TEST',
    phase_2_5_signature: true
  };

  try {
    const { error } = await db.rpc('append_hal_audit_chain', {
      source_table: 'substance_gate_events',
      source_id: gateEventId,
      event_payload: payload
    });

    if (error) throw error;
  } catch (error: any) {
    console.error('[GateWriter] Error appending hal_audit_chain:', error.message);
  }
}
