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

export async function slashRepIDForGateFail(
  db: SupabaseClient, 
  agentName: string, 
  taskId: string | number, 
  reapCount: number, 
  gateEventId: string
) {
  const delta = reapCount > 3 ? -150 : -50;

  try {
    // Step 1: Look up agent UUID and current RepID
    const { data: agent, error: lookupError } = await db
      .from('repid_agents')
      .select('id, current_repid')
      .eq('agent_name', agentName)
      .single();

    if (lookupError || !agent) {
      console.error(`[GateWriter] Agent ${agentName} not found in repid_agents:`, lookupError?.message);
      return delta;  // graceful degradation
    }

    const repidBefore = agent.current_repid ?? 1000;
    const repidAfter = Math.max(0, repidBefore + delta);

    // Step 2: Write score event with UUID and NOT NULL fields
    const { error: insertError } = await db.from('repid_score_events').insert({
      agent_id: agent.id,           // UUID, correct type
      event_type: 'EPISTEMIC_VIOLATION',
      delta: delta,
      repid_before: repidBefore,    // NOT NULL satisfied
      repid_after: repidAfter,      // NOT NULL satisfied
      metadata: {
        failure_subtype: 'substance_gate_fast_path',
        fast_path_failure: true,
        task_id: taskId,
        reap_count: reapCount,
        gate_event_id: gateEventId,
        agent_name: agentName  // preserve agent name for human readability
      }
    });

    if (insertError) {
      console.error('[GateWriter] Error inserting repid_score_events:', insertError.message);
      return delta;
    }

    // Step 3: Update agent's current_repid so the slash persists
    const { error: updateError } = await db
      .from('repid_agents')
      .update({ 
        current_repid: repidAfter, 
        last_updated: new Date().toISOString() 
      })
      .eq('agent_name', agentName);

    if (updateError) {
      console.error('[GateWriter] Error updating repid_agents.current_repid:', updateError.message);
    }
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
