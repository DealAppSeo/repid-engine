/**
 * Sprint A7 — score-event pipeline.
 *
 * runScoreEvent(input) is the single entry point that turns
 * (prompt, answer) + agent state into:
 *   1. HAL evaluation (signals + score + decision)
 *   2. RepID delta (calculated + applied, vesting-aware)
 *   3. repid_score_events row (canonical history)
 *   4. repid_agents.current_repid update
 *   5. ZK proof queue trigger when delta magnitude warrants
 *
 * Idempotency: callers may pass an idempotency_key; same key → same row,
 * never re-processed.
 *
 * HAL failures are non-fatal: if the evaluator throws, the event is logged
 * with hal_score=0.5, hal_decision='flagged', and signals.error='hal_failure'.
 *
 * agent_repid_history is intentionally NOT written to. The canonical
 * history lives in repid_score_events (per CLAUDE.md). The legacy
 * agent_repid_history table is reserved for payment-linked deltas with
 * its own NOT NULL payment_proof_hash constraint.
 */

import crypto from 'crypto';
import { db } from '../db';
import { evaluate } from '../hal/lib/evaluate';
import {
  HAL_DEFAULT_VETO_THRESHOLD,
  HAL_CONSTITUTIONAL_BLOCK_THRESHOLD,
} from '../hal/lib/constants';
import { computeDelta, HALDecision } from './repid-delta';
import { appendToAuditChain } from '../services/auditChainWriter';
import { extractHALSignals } from '../hal/lib/extract';

export function canonicalizeProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const clean = provider.toLowerCase().trim();
  if (clean.includes('gemini')) return 'gemini';
  if (clean.includes('anthropic') || clean.includes('claude')) return 'anthropic';
  if (clean.includes('openai') || clean.includes('gpt')) return 'openai';
  if (clean.includes('deepseek')) return 'deepseek';
  if (clean.includes('groq') || clean.includes('grok')) return 'groq';
  if (clean.includes('cerebras')) return 'cerebras';
  if (clean.includes('cohere')) return 'cohere';
  return clean;
}

export interface ScoreEventInput {
  agent_id: string;
  prompt: string;
  answer: string;
  provider_used?: string;
  tier_used?: string;
  model_used?: string;
  llm_call_id?: string;
  task_domain?: string;
  certainty?: number;
  idempotency_key?: string;
  contract_id?: string;
}

export interface ScoreEventResult {
  score_event_id: number;
  hal_score: number;
  hal_decision: HALDecision;
  signals: Record<string, unknown>;
  repid_delta_calculated: number;
  repid_delta_applied: number;
  old_repid: number;
  new_repid: number;
  zk_proof_triggered: boolean;
  zk_proof_id: string | null;
  reason: string;
  idempotent_replay?: boolean;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function deriveHalDecision(hal_score: number, vetoed: boolean, comma_severity?: string | null): HALDecision {
  // vetoed boolean OR critical Comma BFT severity → 'vetoed'
  if (vetoed || comma_severity === 'critical') {
    return 'vetoed';
  }
  // borderline (no penalty applied, but flagged for monitoring)
  if (hal_score >= 0.40) {
    return 'flagged';
  }
  // clean (positive RepID delta)
  return 'clean';
}

async function loadAgent(agentId: string): Promise<{
  id: string;
  current_repid: number;
  tier: string;
  vesting_cliff_active: boolean;
} | null> {
  const { data, error } = await db
    .from('repid_agents')
    .select('id, current_repid, tier, vesting_cliff_ends_at')
    .eq('id', agentId)
    .single();
  if (error || !data) return null;
  const cliffEnds = (data as any).vesting_cliff_ends_at;
  const vesting_cliff_active =
    typeof cliffEnds === 'string' && new Date(cliffEnds).getTime() > Date.now();
  return {
    id: (data as any).id,
    current_repid: Number((data as any).current_repid ?? 1000),
    tier: String((data as any).tier ?? 'PROBATIONARY'),
    vesting_cliff_active,
  };
}

async function loadExistingByKey(key: string): Promise<ScoreEventResult | null> {
  const { data, error } = await db
    .from('repid_score_events')
    .select(
      'id, hal_score, hal_decision, metadata, repid_delta_calculated, repid_delta_applied, repid_before, repid_after, zk_proof_triggered, zk_proof_id'
    )
    .eq('idempotency_key', key)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as any;
  return {
    score_event_id: Number(row.id),
    hal_score: Number(row.hal_score ?? 0),
    hal_decision: (row.hal_decision ?? 'clean') as HALDecision,
    signals: (row.metadata && row.metadata.hal_signals) ?? {},
    repid_delta_calculated: Number(row.repid_delta_calculated ?? row.repid_after - row.repid_before),
    repid_delta_applied: Number(row.repid_delta_applied ?? row.repid_after - row.repid_before),
    old_repid: Number(row.repid_before ?? 0),
    new_repid: Number(row.repid_after ?? 0),
    zk_proof_triggered: Boolean(row.zk_proof_triggered),
    zk_proof_id: row.zk_proof_id ?? null,
    reason: 'idempotent replay',
    idempotent_replay: true,
  };
}

async function shouldTriggerProof(agentId: string, deltaMagnitude: number): Promise<boolean> {
  if (deltaMagnitude >= 5) return true;
  const { count } = await db
    .from('repid_score_events')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);
  // Trigger every 10th event (count is the count BEFORE this insert).
  return typeof count === 'number' && count > 0 && (count + 1) % 10 === 0;
}

export async function runScoreEvent(
  input: ScoreEventInput
): Promise<ScoreEventResult> {
  // 1. Idempotency check.
  if (input.idempotency_key) {
    const existing = await loadExistingByKey(input.idempotency_key);
    if (existing) return existing;
  }

  // 2. Load agent.
  const agent = await loadAgent(input.agent_id);
  if (!agent) {
    throw new NotFoundError(`Agent not found: ${input.agent_id}`);
  }

  // 3. HAL evaluation — extractor-only path (strictness 1) keeps this
  //    synchronous and avoids LLM fan-out inside scoring. Cross-LLM
  //    consensus is owned by /score-event's older v11 path and by the
  //    /complete handler which has provider context.
  let hal_score = 0.5;
  let vetoed = false;
  let signals: Record<string, unknown> = {};
  let halError: string | null = null;
  try {
    const result = await evaluate(input.answer, input.answer, {
      domain: input.task_domain ?? 'finance',
      certainty: typeof input.certainty === 'number' ? input.certainty : 0.85,
      strictness: 1,
    });
    hal_score = Number.isFinite(result.hal_score) ? result.hal_score : 0.5;
    vetoed = !!result.vetoed;
    signals = result.signals as unknown as Record<string, unknown>;
  } catch (e: unknown) {
    halError = e instanceof Error ? e.message : String(e);
    signals = { error: 'hal_failure', message: halError };
    hal_score = 0.5;
    vetoed = false;
  }

  const decision: HALDecision = halError ? 'flagged' : deriveHalDecision(hal_score, vetoed, signals.comma_severity as string | null);

  // 4. Compute delta.
  const delta = computeDelta({
    hal_score,
    hal_decision: decision,
    current_repid: agent.current_repid,
    agent_tier: agent.tier,
    vesting_cliff_active: agent.vesting_cliff_active,
  });

  const old_repid = agent.current_repid;
  const new_repid = old_repid + delta.delta_applied;

  // 5. ZK proof trigger logic (decided pre-insert so we can record on the row).
  const triggerProof = await shouldTriggerProof(
    input.agent_id,
    Math.abs(delta.delta_applied)
  );
  const zk_proof_id = triggerProof ? crypto.randomUUID() : null;

  // 6. Insert score event.
  const insertPayload: Record<string, unknown> = {
    agent_id: input.agent_id,
    event_type: 'HAL_SCORE_EVENT',
    delta: Math.round(delta.delta_applied),
    repid_before: old_repid,
    repid_after: Math.round(new_repid),
    certainty_at_claim:
      typeof input.certainty === 'number' ? input.certainty : 0.85,
    contract_id: input.contract_id ?? null,
    llm_provider: canonicalizeProvider(input.provider_used),
    llm_model: input.model_used ?? null,
    hal_score,
    hal_decision: decision,
    repid_delta_calculated: Math.round(delta.delta_calculated),
    repid_delta_applied: Math.round(delta.delta_applied),
    tier_used: input.tier_used ?? null,
    prompt_text: input.prompt,
    answer_text: input.answer,
    llm_call_id: input.llm_call_id ?? null,
    task_domain: input.task_domain ?? null,
    decision_outcome: decision,
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    idempotency_key: input.idempotency_key ?? null,
    metadata: {
      hal_signals: signals,
      hal_error: halError,
      delta_reason: delta.reason,
      vesting_cliff_active: agent.vesting_cliff_active,
      block_threshold_used: HAL_CONSTITUTIONAL_BLOCK_THRESHOLD,
    },
  };

  const { data: eventRow, error: evErr } = await db
    .from('repid_score_events')
    .insert(insertPayload)
    .select('id')
    .single();

  if (evErr || !eventRow) {
    throw new Error(`score event insert failed: ${evErr?.message ?? 'unknown'}`);
  }
  const score_event_id = Number((eventRow as any).id);

  // Write to hal_classifications to record the HAL inference so /api/v1/hal/stats reports it
  try {
    const promptHash = crypto.createHash('sha256').update(input.prompt).digest('hex').slice(0, 32);
    const categoryMapping: Record<string, string> = {
      'factual': 'factual',
      'opinion': 'opinion',
      'math': 'math',
      'code': 'code',
      'creative': 'creative',
      'time-sensitive': 'time-sensitive'
    };
    const taskTypeClean = String(input.task_domain || '').toLowerCase().trim();
    const category = categoryMapping[taskTypeClean] || 'factual';

    await db.from('hal_classifications').insert({
      prompt_hash: promptHash,
      category,
      confidence: 'high',
      latency_ms: 0,
      provider: canonicalizeProvider(input.provider_used) || 'trinity-task-bridge',
      model: 'deterministic-extractor',
    });
  } catch (err: any) {
    console.warn('[scoring/pipeline] Failed to write to hal_classifications:', err.message);
  }

  // 7. Update agent state (gated by WRITER_DIRECT_APPLY for single-applier cutover).
  // When false: insert event only (with full audit fields + idempotency_key); aggregator becomes sole applier.
  const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
  if (WRITER_DIRECT_APPLY) {
    await db
      .from('repid_agents')
      .update({
        current_repid: Math.round(new_repid),
        last_active_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      })
      .eq('id', input.agent_id);
  } else {
    // Event already written above with repid_before/after + delta. Aggregator will apply from watermark.
  }

  // 8. Queue ZK proof job (best-effort; failures don't block).
  if (triggerProof && zk_proof_id) {
    db.from('repid_proof_queue')
      .insert({
        job_id: zk_proof_id,
        agent_id: input.agent_id,
        event_id: score_event_id,
        status: 'pending',
        zkp_service_url: process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app',
      })
      .then(
        () => {
          fetch(`${process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'}/zkp/repid-proof`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              agent_id: input.agent_id, 
              score: Math.round(new_repid),
              metadata: { job_id: zk_proof_id }
            })
          }).catch(err => console.error('[scoring/pipeline] proof service call failed:', err));
        },
        (err: unknown) => console.error('[scoring/pipeline] proof queue insert failed:', err)
      );
  }

  // 9. Leaderboard refresh — repid_leaderboard_public is a regular VIEW
  //    (not materialized) per Phase 1 schema query, so no refresh needed.

  return {
    score_event_id,
    hal_score,
    hal_decision: decision,
    signals,
    repid_delta_calculated: delta.delta_calculated,
    repid_delta_applied: delta.delta_applied,
    old_repid,
    new_repid: Math.round(new_repid),
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    reason: delta.reason,
  };
}

export async function applyValidationEvent(
  agent_id: string,
  event_type: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' | 'SERVICE_FULFILLED' | 'SERVICE_SATISFIED',
  delta: number,
  metadata: Record<string, any> = {},
  halOverride?: { hal_score: number; hal_decision: 'vetoed' | 'flagged' | 'clean'; hal_signals?: any }
) {
  const agent = await loadAgent(agent_id);
  if (!agent) throw new Error(`Agent not found: ${agent_id}`);

  const old_repid = agent.current_repid;
  const new_repid = Math.max(0, old_repid + delta); // simple floor 0

  const triggerProof = await shouldTriggerProof(agent_id, Math.abs(delta));
  const zk_proof_id = triggerProof ? crypto.randomUUID() : null;

  // HAL enrichment (2026-05-22): callers may pass real HAL via halOverride.
  // Default (no override) preserves the prior 0.5/clean placeholder so the
  // existing 4-arg callers are byte-for-byte unchanged. decision_outcome now
  // tracks hal_decision (was always 'clean'); with no override it stays 'clean'.
  let certaintyAtClaim: number | null = null;
  let halScore = halOverride?.hal_score ?? 0.5;
  let halDecision = halOverride?.hal_decision ?? 'clean';
  let enrichedMetadata = halOverride?.hal_signals
    ? { ...metadata, hal_signals: halOverride.hal_signals }
    : metadata;

  const answerText = metadata?.answer_text || null;
  const promptText = metadata?.prompt_text || null;
  const taskDomain = metadata?.task_domain || 'finance';

  if (answerText && answerText.trim()) {
    try {
      const signals = extractHALSignals({
        text: answerText,
        domain: taskDomain,
        certainty: typeof halOverride?.hal_signals?.certainty_at_claim === 'number'
          ? halOverride.hal_signals.certainty_at_claim
          : (typeof metadata?.certainty === 'number'
              ? metadata.certainty
              : (typeof metadata?.certainty_at_claim === 'number'
                  ? metadata.certainty_at_claim
                  : 0.85))
      });
      certaintyAtClaim = signals.certainty_at_claim;
      
      if (!halOverride) {
        const scoreVal = (
          0.4 * signals.harm_probability +
          0.3 * signals.epistemic_uncertainty +
          0.2 * (1 - signals.evidence_quality) +
          0.1 * (1 - signals.scope_appropriateness)
        ) * (531441 / 524288);
        halScore = Math.min(1, scoreVal);
        halDecision = deriveHalDecision(halScore, halScore >= 0.25);
        enrichedMetadata = {
          ...metadata,
          hal_signals: signals
        };
      } else {
        certaintyAtClaim = typeof halOverride.hal_signals?.certainty_at_claim === 'number'
          ? halOverride.hal_signals.certainty_at_claim
          : 0.85;
      }
    } catch (err: any) {
      console.error('[applyValidationEvent] Failed to run extractHALSignals:', err.message);
    }
  } else if (halOverride?.hal_signals) {
    certaintyAtClaim = typeof halOverride.hal_signals.certainty_at_claim === 'number'
      ? halOverride.hal_signals.certainty_at_claim
      : null;
  }

  const insertPayload = {
    agent_id,
    event_type,
    delta: Math.round(delta),
    repid_before: old_repid,
    repid_after: Math.round(new_repid),
    certainty_at_claim: certaintyAtClaim,
    hal_score: halScore,
    hal_decision: halDecision,
    repid_delta_calculated: Math.round(delta),
    repid_delta_applied: Math.round(new_repid - old_repid),
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    decision_outcome: halDecision,
    metadata: enrichedMetadata,
    contract_id: metadata?.contract_id ?? null,
    answer_text: answerText,
    prompt_text: promptText,
    task_domain: taskDomain,
  };

  const { data: eventRow, error: evErr } = await db
    .from('repid_score_events')
    .insert(insertPayload)
    .select('id')
    .single();

  if (evErr) throw new Error(`score event insert failed: ${evErr.message}`);

  const score_event_id = (eventRow as any).id;

  await db
    .from('repid_agents')
    .update({
      current_repid: Math.round(new_repid),
      last_active_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    })
    .eq('id', agent_id);

  // Patent-evidence audit anchor for service-contract fulfilment. The
  // validation_queue path anchors at the queue level (validation-queue-
  // worker.ts); SERVICE_FULFILLED events flow through the service-contract
  // path (applyServiceFulfilledDeltas) which has no queue row, so the
  // anchor MUST happen here or hal_audit_chain has zero anchors for them.
  // Gated strictly to SERVICE_FULFILLED so the validation_queue events are
  // not double-anchored. Isolated try/catch: the score event is already
  // persisted; an anchor failure must NOT rethrow and falsely fail the
  // delta — but it is a patent surface, so it fails LOUDLY with a stack
  // (RULE-11), never silently. Mirrors validation-queue-worker.ts:171-189.
  if (event_type === 'SERVICE_FULFILLED') {
    try {
      await appendToAuditChain('repid_score_events', String(score_event_id), {
        event_type: 'SERVICE_FULFILLED',
        score_event_id,
        agent_id,
        role: metadata.role ?? null,
        contract_id: metadata.contract_id ?? null,
        service_id: metadata.service_id ?? null,
        delta: Math.round(delta),
        repid_before: old_repid,
        repid_after: Math.round(new_repid),
        hal_score: halScore,
        hal_decision: halDecision,
        phase_2_7_4_signature: true,
      });
    } catch (auditErr: any) {
      console.error(
        `[scoring/pipeline] hal_audit_chain append FAILED for repid_score_events ` +
          `${score_event_id} (SERVICE_FULFILLED recorded but NOT anchored — ` +
          `patent-surface gap):`,
        auditErr?.stack ?? auditErr
      );
    }
  }

  if (triggerProof && zk_proof_id) {
    db.from('repid_proof_queue')
      .insert({
        job_id: zk_proof_id,
        agent_id,
        event_id: (eventRow as any).id,
        status: 'pending',
        zkp_service_url: process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app',
      })
      .then(() => {
        fetch(`${process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'}/zkp/repid-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            agent_id, 
            score: Math.round(new_repid),
            metadata: { job_id: zk_proof_id }
          })
        }).catch((err: any) => console.error('[scoring/pipeline] proof service call failed:', err));
      }).then(undefined, (err: any) => console.error('[scoring/pipeline] proof queue insert failed:', err));
  }

  return { old_repid, new_repid, delta_applied: Math.round(new_repid - old_repid) };
}
