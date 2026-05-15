import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Extract provenance tags from a task for propagation to derivative events.
 * Per Provenance Framework v1.0.
 */
function extractProvenance(task: any) {
  const m = task.metadata || {};
  return {
    test_tier: m.test_tier || 'T0_INTERNAL_DEV_TEST',
    test_source: m.test_source || null,
    external_party_id: m.external_party_id || null,
    external_party_aware: m.external_party_aware ?? null,
    adversarial_planted: m.adversarial_planted ?? false,
    patent_eligible: m.patent_eligible ?? false,
    parent_task_id: task.id
  };
}

// Module-level cache. Populated lazily on first miss per agent name.
// Cache lives for the process lifetime; new agents added to repid_agents
// will require a process restart to be cached. This is acceptable because
// the 12-agent set is stable for the foreseeable future.
const agentUuidCache = new Map<string, string>();

/**
 * Look up an agent's UUID, with module-level cache.
 * Returns null if agent not found in repid_agents.
 */
async function getAgentUuid(db: SupabaseClient, agentName: string): Promise<string | null> {
  if (agentUuidCache.has(agentName)) {
    return agentUuidCache.get(agentName) || null;
  }
  
  const { data, error } = await db
    .from('repid_agents')
    .select('id')
    .eq('agent_name', agentName)
    .single();
  
  if (error || !data) {
    console.error(`[GateWriter] Agent UUID lookup failed for ${agentName}:`, error?.message);
    return null;
  }
  
  agentUuidCache.set(agentName, data.id);
  return data.id;
}

// Export for testability
export function clearAgentUuidCache() {
  agentUuidCache.clear();
}


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

export async function recordGateEvent(
  db: SupabaseClient, 
  task: any, 
  fastResult: FastPathResult, 
  agentName: string,
  contentHash: string  // NEW REQUIRED PARAMETER
) {
  try {
    const { data, error } = await db.from('substance_gate_events').insert({
      task_id: task.id,
      agent_name: agentName,
      char_count: fastResult.signals.chars.value,
      result_excerpt: (task.result || '').substring(0, 500),
      content_hash: contentHash,  // Use the passed-in hash
      signal_char_passed: fastResult.signals.chars.passed,
      signal_wrapper_passed: fastResult.signals.wrapper.passed,
      signal_artifact_passed: fastResult.signals.artifact.passed,
      signal_noop_passed: fastResult.signals.noop.passed,
      passed: fastResult.passed,
      failure_reasons: fastResult.failures,
      composite_score: fastResult.composite_score,
      task_tier: task.metadata?.test_tier || 'T0_INTERNAL_DEV_TEST',
      reap_count: task.metadata?.reap_count || 0,
      metadata: {
        ...(task.metadata || {}),
        phase_2_5_writer_version: '2.5.0'
      }
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
  task: any, 
  reapCount: number, 
  gateEventId: string
) {
  const delta = reapCount > 3 ? -150 : -50;

  try {
    // Step 1: Get UUID (cached lookup)
    const agentUuid = await getAgentUuid(db, agentName);
    if (!agentUuid) {
      return delta;  // graceful degradation logged in getAgentUuid
    }

    // Step 2: Fetch current_repid (NOT cached — this changes)
    const { data: agent, error: lookupError } = await db
      .from('repid_agents')
      .select('current_repid')
      .eq('agent_name', agentName)
      .single();

    if (lookupError || !agent) {
      console.error(`[GateWriter] current_repid lookup failed for ${agentName}:`, lookupError?.message);
      return delta;
    }

    const repidBefore = agent.current_repid ?? 1000;
    const repidAfter = Math.max(0, repidBefore + delta);

    const provenance = extractProvenance(task);

    // Step 3: Write score event
    const { error: insertError } = await db.from('repid_score_events').insert({
      agent_id: agentUuid,
      event_type: 'EPISTEMIC_VIOLATION',
      delta: delta,
      repid_before: repidBefore,
      repid_after: repidAfter,
      idempotency_key: gateEventId,  // From A3
      metadata: {
        failure_subtype: 'substance_gate_fast_path',
        fast_path_failure: true,
        task_id: task.id,
        reap_count: reapCount,
        gate_event_id: gateEventId,
        agent_name: agentName,
        provenance: provenance  // NEW: full provenance propagation
      }
    });

    if (insertError) {
      console.error('[GateWriter] Error inserting repid_score_events:', insertError.message);
      return delta;
    }

    // Step 4: Update current_repid
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
  const provenance = extractProvenance(task);
  const payload = {
    task_id: task.id,
    agent_name: agentName,
    passed: fastResult.passed,
    failure_reasons: fastResult.failures,
    composite_score: fastResult.composite_score,
    char_count: fastResult.signals.chars.value,
    phase_2_5_signature: true,
    provenance: provenance  // NEW: full provenance propagation
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
