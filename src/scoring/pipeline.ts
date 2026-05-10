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
  // Optional caller API key. Threaded from request handlers so the
  // hal_evaluations dual-write hook can record api_key_hash (sha256 of
  // this value, applied inside writeHalEvaluation). Never stored raw.
  api_key?: string;
}

// HALDecision (clean/flagged/vetoed) → hal_evaluations.decision CHECK
// constraint values (APPROVE/HITL/BLOCK/VETO). Kept here so the
// downstream taxonomy is centralized.
function mapDecisionForHalEvaluations(d: HALDecision): 'APPROVE' | 'HITL' | 'VETO' {
  if (d === 'vetoed') return 'VETO';
  if (d === 'flagged') return 'HITL';
  return 'APPROVE';
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
    llm_provider: input.provider_used ?? null,
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

  // 6b. Dual-write to hal_evaluations (unified evaluation table).
  // Gated by HAL_EVALUATIONS_DUAL_WRITE inside the helper. Fire-and-forget
  // — helper handles its own errors. This is the runScoreEvent-side hook
  // that captures real SDK traffic (the strictness=1 path that bypasses
  // classify() and therefore the two existing classify-side hooks).
  // Refs: MVP_BACKEND_READINESS_REPORT 2026-05-09 Phase 3 finding.
  try {
    const { writeHalEvaluation } = require('../services/hal-evaluations-writer');
    const commaGap = typeof (signals as any)?.comma_gap === 'number'
      ? (signals as any).comma_gap as number
      : undefined;
    void writeHalEvaluation({
      mode: 'production',
      prompt_text: input.prompt,
      prompt_source: 'production_traffic',
      agent_id: input.agent_id,
      api_key: input.api_key,
      gen_provider: input.provider_used,
      gen_model: input.model_used,
      hal_signals: signals,
      certainty_used: typeof input.certainty === 'number' ? input.certainty : undefined,
      hal_score,
      comma_gap: commaGap,
      hal_vetoed: vetoed,
      decision: halError ? undefined : mapDecisionForHalEvaluations(decision),
      repid_delta: delta.delta_applied,
      notes: `runScoreEvent strictness=1 score_event_id=${score_event_id} tier=${input.tier_used ?? 'unknown'}`,
    });
  } catch (e) {
    // writer helper handles its own internal errors; this catch is for require/params errors
    console.warn('[scoring/pipeline] hal_evaluations dual-write hook failed:', e);
  }

  // 7. Update agent state.
  await db
    .from('repid_agents')
    .update({
      current_repid: Math.round(new_repid),
      last_active_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    })
    .eq('id', input.agent_id);

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
