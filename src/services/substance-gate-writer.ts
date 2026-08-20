import { SupabaseClient } from '@supabase/supabase-js';
import { appendToAuditChain } from './auditChainWriter';
import { extractHALSignals } from '../hal/lib/extract';
import { scoreEventGuardEnforced } from '../routes/score-event-guard';
import { insertScoreEvent } from '../scoring/score-event-writer';

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

    let certaintyAtClaim = 0.85;
    let halScore = 0.5;
    let halSignals: any = null;

    try {
      const deliverable = task.result || '';
      const domain = task.task_type || 'finance';
      if (deliverable.trim().length > 0) {
        const signals = extractHALSignals({
          text: deliverable,
          domain,
          certainty: 0.85
        });
        certaintyAtClaim = signals.certainty_at_claim;
        halSignals = signals;

        const scoreVal = (
          0.4 * signals.harm_probability +
          0.3 * signals.epistemic_uncertainty +
          0.2 * (1 - signals.evidence_quality) +
          0.1 * (1 - signals.scope_appropriateness)
        ) * (531441 / 524288);
        halScore = Math.min(1, scoreVal);
      }
    } catch (err: any) {
      console.error('[GateWriter] Failed to extract HAL signals:', err.message);
    }

    const scoreEventMetadata = {
      failure_subtype: 'substance_gate_fast_path',
      fast_path_failure: true,
      task_id: task.id,
      reap_count: reapCount,
      gate_event_id: gateEventId,
      agent_name: agentName,
      provenance: provenance,  // NEW: full provenance propagation
      hal_signals: halSignals
    };

    // Step 3: Write score event
    //
    // ORDER, NOT ARITHMETIC, IS WHAT DECIDES THE DOUBLE-APPLY. #326 classified this
    // writer benign because its `current_repid` write (Step 4) happens AFTER the
    // insert. Re-verified independently on prod 2026-08-03 in a rolled-back
    // transaction, replaying this exact sequence:
    //
    //     before=499  callerComputedAfter=449
    //     after INSERT only:  current_repid=449   (trigger applied -50)
    //     row: before=499 after=449 applied=-50   (trigger stamped both)
    //     after caller UPDATE: current_repid=449  == single-apply  => DOUBLE=false
    //
    // Confirmed: NOT a double-apply. The trigger applies relatively, the caller then
    // writes the same absolute value on top. Still worth migrating, because the two
    // appliers agree only by arithmetic — one concurrent event between the Step-2
    // read and this insert and the Step-4 absolute write silently clobbers it.
    //
    // AND THE TWO APPLIERS DO NOT AGREE ON THE FLOOR. Line 137 clamps with
    // `Math.max(0, ...)`; the trigger's UPDATE has no clamp at all; and the DB
    // enforces `CHECK (current_repid >= 10 AND current_repid <= 10000)`. So for any
    // agent whose score is below the slash, the trigger's unclamped UPDATE trips
    // the constraint and takes the whole insert down with it:
    //
    //     ERROR 23514: new row for relation "repid_agents" violates check
    //                  constraint "repid_agents_current_repid_check"
    //     CONTEXT: SQL statement "UPDATE repid_agents SET current_repid = ..."
    //              PL/pgSQL function apply_repid_score_event() line 25
    //
    // caught by the outer catch, logged, and `delta` returned as though the slash
    // landed. 2 active agents sit below 150 right now, so a reap_count>3 (-150)
    // slash on either is a silent no-op today. `src/services/repid-earning.ts:173`
    // is the writer that gets this right — it clamps to [10, 10000], the DB's own
    // range, and records `appliedDelta = after - before` rather than the intended
    // delta. The guarded branch below follows it.
    const appliedDelta = repidAfter - repidBefore;

    if (scoreEventGuardEnforced()) {
      // Refuse rather than land a row the score cannot match. In enforce mode the
      // trigger stands down, so a repidAfter outside the DB's range no longer
      // aborts the insert — it would leave an audit row claiming a score that
      // Step 4 then fails to write. A missing entry beats a lying one.
      if (repidAfter < 10 || repidAfter > 10000) {
        console.error(
          `[GateWriter] refusing score event for ${agentName}: repid_after=${repidAfter} is outside ` +
          `repid_agents_current_repid_check [10, 10000] (before=${repidBefore}, delta=${delta}). ` +
          `The Math.max(0, ...) floor at line 137 disagrees with the DB floor of 10.`
        );
        return delta;
      }

      const res = await insertScoreEvent({
        applier: 'caller',
        agent_id: agentUuid,
        event_type: 'EPISTEMIC_VIOLATION',
        delta: delta,
        idempotency_key: gateEventId,
        metadata: scoreEventMetadata,
        repid_before: repidBefore,
        repid_after: repidAfter,
        // The clamp means the applied movement can be smaller than the intended
        // delta. Recording `delta` here instead would break the helper's
        // reconciliation invariant, which is the whole point of the guard.
        repid_delta_applied: appliedDelta,
        repid_delta_calculated: delta,
        extra: {
          certainty_at_claim: certaintyAtClaim,
          hal_score: halScore,
          hal_decision: 'flagged',
          answer_text: task.result || null,
          prompt_text: task.description || task.title || null,
          task_domain: task.task_type || null,
        },
      });

      if (!res.ok) {
        console.error('[GateWriter] Error inserting repid_score_events:', res.error);
        return delta;
      }
    } else {
      const { error: insertError } = await db.from('repid_score_events').insert({
        agent_id: agentUuid,
        event_type: 'EPISTEMIC_VIOLATION',
        delta: delta,
        repid_before: repidBefore,
        repid_after: repidAfter,
        certainty_at_claim: certaintyAtClaim,
        hal_score: halScore,
        hal_decision: 'flagged',
        answer_text: task.result || null,
        prompt_text: task.description || task.title || null,
        task_domain: task.task_type || null,
        idempotency_key: gateEventId,  // From A3
        metadata: scoreEventMetadata
      });

      if (insertError) {
        console.error('[GateWriter] Error inserting repid_score_events:', insertError.message);
        return delta;
      }
    }

    // Step 4: Update current_repid (gated by WRITER_DIRECT_APPLY for single-applier cutover D-054/D-055)
    const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
    if (WRITER_DIRECT_APPLY) {
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
    } else {
      // Event inserted above with delta + idempotency_key. Aggregator applies; no double-count.
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
    // Correct 4-arg p_-prefixed RPC via the shared helper (which also
    // computes canonicalJson). The prior raw 3-arg unprefixed call matched
    // no function and was silently swallowed → 0 gate events anchored.
    await appendToAuditChain('substance_gate_events', gateEventId, payload);
  } catch (error: any) {
    // Keep gate recording resilient, but FAIL LOUDLY (stack). This is
    // audit surface (P-001/P-003) — a silent swallow here means the gate
    // event is never anchored. Never let signature drift be invisible again.
    console.error(
      `[GateWriter] hal_audit_chain append FAILED for substance_gate_events ${gateEventId} ` +
      `(gate event NOT anchored — audit-surface gap):`,
      error?.stack ?? error
    );
  }
}
