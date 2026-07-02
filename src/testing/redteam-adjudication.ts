/**
 * S-REDTEAM-R2 Phase 3 — asymmetric red-team adjudication.
 *
 * Three outcomes, each a distinct RepID movement through repid_score_events (earned-floor enforced by
 * the DB trigger trg_repid_earned_floor; these are NOT HAL_SCORE_EVENT rows so the S-DRAIN penalty
 * gate does not touch them — a caught fault is a real penalty):
 *
 *   good_catch     — finder filed a REJECT WITH EVIDENCE that was upheld → +finder, −subject
 *   lazy_subject   — subject artifact missing/NO_ARTIFACT_SAVED/failed substance gate → −subject (+finder if one caught it)
 *   frivolous_reject — accuser's REJECT was overturned with no merit → −accuser (subject vindicated, 0)
 *
 * Asymmetry rationale: catching a real fault is rewarded; shipping nothing/garbage is penalized
 * hardest; a bad-faith accusation is penalized but less than a real fault. Writes a red_team_results
 * row per adjudication (turns that table 0→real) and returns the applied deltas for verification.
 */
import { db } from '../db';
import { emitOnChainOutboxEvent } from '../services/onchain-outbox';
import type { OnChainEligibleEventType } from '../workers/feedback-loop-filters';

export const REDTEAM_REWARDS = {
  FINDER_REWARD: 5,    // upheld REJECT-with-evidence
  SUBJECT_PENALTY: 10, // lazy/overturned subject (mirrors the HAL veto magnitude)
  ACCUSER_PENALTY: 5,  // frivolous overturned REJECT
} as const;

export type AdjudicationCase = 'good_catch' | 'lazy_subject' | 'frivolous_reject';

export interface AdjudicationInput {
  case: AdjudicationCase;
  challenge_id: string;
  finder?: string | null;   // verifier/accuser agent_name
  subject?: string | null;  // agent whose artifact is judged
  evidence?: string;        // REJECT evidence text
  artifact_url?: string | null;
  substance_passed?: boolean;
}

export interface AppliedDelta { agent: string; agentId: string | null; role: 'finder' | 'subject' | 'accuser'; delta: number; before: number; after: number; event_type: string; }

// Maps an adjudication case to its ERC-8004 outbox event_type (feat/verify-
// redteam-repid-erc8004, 2026-07-02). These are consumed by FeedbackLoopWorker
// via ONCHAIN_ELIGIBLE_EVENT_TYPES so a caught fault also lands on-chain.
const CASE_TO_OUTBOX_EVENT: Record<AdjudicationCase, OnChainEligibleEventType> = {
  good_catch: 'redteam_good_catch',
  lazy_subject: 'redteam_lazy_subject',
  frivolous_reject: 'redteam_frivolous_reject',
};
export interface AdjudicationResult { case: AdjudicationCase; challenge_id: string; deltas: AppliedDelta[]; red_team_result_id: number | null; }

async function resolveAgent(agent: string): Promise<{ id: string | null; current_repid: number }> {
  const { data } = await db.from('repid_agents').select('id, current_repid').eq('agent_name', agent).maybeSingle();
  return { id: (data as any)?.id ?? null, current_repid: (data as any)?.current_repid ?? 100 };
}

/**
 * Apply a RepID delta through repid_score_events + repid_agents; the earned-floor trigger clamps.
 * NOTE: repid_score_events keys on agent_id (uuid → repid_agents.id); it has NO agent_name column.
 */
async function applyDelta(agent: string, role: AppliedDelta['role'], delta: number, eventType: string, meta: any): Promise<AppliedDelta> {
  const { id, current_repid: before } = await resolveAgent(agent);
  // Direct apply (engine WRITER_DIRECT_APPLY pattern); trg_repid_earned_floor enforces the floor.
  await db.from('repid_agents').update({ current_repid: Math.max(0, Math.round(before + delta)), last_updated: new Date().toISOString() }).eq('agent_name', agent);
  const after = (await resolveAgent(agent)).current_repid; // read back the post-trigger value
  const { error } = await db.from('repid_score_events').insert({
    agent_id: id, event_type: eventType,
    delta, repid_before: before, repid_after: after,
    metadata: { ...meta, redteam: true, role, agent_name: agent, source: 'S-REDTEAM-R2' },
  });
  if (error) throw new Error(`repid_score_events insert failed for ${agent}: ${error.message}`);
  return { agent, agentId: id, role, delta, before, after, event_type: eventType };
}

/** Whether a subject's artifact counts as "lazy" (no real deliverable). */
export function isLazyArtifact(artifact_url?: string | null, substance_passed?: boolean): boolean {
  if (substance_passed === false) return true;
  if (artifact_url == null) return true;
  const u = String(artifact_url).trim().toUpperCase();
  return u === '' || u === 'NO_ARTIFACT_SAVED' || u === 'NULL';
}

export async function adjudicate(input: AdjudicationInput): Promise<AdjudicationResult> {
  const deltas: AppliedDelta[] = [];
  let detected = false, falsePositive = false, attacker: string | null = null, defender: string | null = null, deltaAtt = 0, deltaDef = 0;

  // event_type must be in the repid_score_events whitelist; the redteam role/case lives in metadata.
  // finder reward → VALIDATOR_REWARD · subject fault → VALIDATION_FAILED · accuser frivolous → VALIDATOR_PENALTY.
  if (input.case === 'good_catch') {
    detected = true;
    if (input.finder) { deltas.push(await applyDelta(input.finder, 'finder', +REDTEAM_REWARDS.FINDER_REWARD, 'VALIDATOR_REWARD', { challenge_id: input.challenge_id, redteam_case: input.case, evidence: input.evidence ?? null })); attacker = input.finder; deltaAtt = +REDTEAM_REWARDS.FINDER_REWARD; }
    if (input.subject) { deltas.push(await applyDelta(input.subject, 'subject', -REDTEAM_REWARDS.SUBJECT_PENALTY, 'VALIDATION_FAILED', { challenge_id: input.challenge_id, redteam_case: input.case, reason: 'upheld_reject' })); defender = input.subject; deltaDef = -REDTEAM_REWARDS.SUBJECT_PENALTY; }
  } else if (input.case === 'lazy_subject') {
    detected = true;
    if (input.subject) { deltas.push(await applyDelta(input.subject, 'subject', -REDTEAM_REWARDS.SUBJECT_PENALTY, 'VALIDATION_FAILED', { challenge_id: input.challenge_id, redteam_case: input.case, reason: 'lazy_artifact', artifact_url: input.artifact_url ?? null })); defender = input.subject; deltaDef = -REDTEAM_REWARDS.SUBJECT_PENALTY; }
    if (input.finder) { deltas.push(await applyDelta(input.finder, 'finder', +REDTEAM_REWARDS.FINDER_REWARD, 'VALIDATOR_REWARD', { challenge_id: input.challenge_id, redteam_case: input.case, reason: 'caught_lazy' })); attacker = input.finder; deltaAtt = +REDTEAM_REWARDS.FINDER_REWARD; }
  } else { // frivolous_reject
    detected = false; falsePositive = true;
    if (input.finder) { deltas.push(await applyDelta(input.finder, 'accuser', -REDTEAM_REWARDS.ACCUSER_PENALTY, 'VALIDATOR_PENALTY', { challenge_id: input.challenge_id, redteam_case: input.case, reason: 'overturned_frivolous' })); attacker = input.finder; deltaAtt = -REDTEAM_REWARDS.ACCUSER_PENALTY; }
    defender = input.subject ?? null; deltaDef = 0; // subject vindicated
  }

  // Audit row in red_team_results (attacker = finder/accuser; defender = subject).
  const attBefore = attacker ? deltas.find((d) => d.agent === attacker)?.before ?? 0 : 0;
  const defBefore = defender ? deltas.find((d) => d.agent === defender)?.before ?? 0 : 0;
  const row = {
    challenge_id: input.challenge_id,
    attack_type: input.case === 'frivolous_reject' ? 'reputation_gaming' : 'factual',
    difficulty: 2,
    attacker_agent: attacker, defender_agent: defender,
    prompt: `[adjudication:${input.case}] ${input.evidence ?? ''}`.slice(0, 500),
    response: (input.artifact_url ?? '').slice(0, 500),
    hal_score: null, hal_verdict: input.case,
    detected, detection_method: input.case === 'frivolous_reject' ? 'missed' : 'peer_reject',
    attacker_repid_before: attBefore, attacker_repid_after: attBefore + deltaAtt, attacker_repid_delta: deltaAtt,
    defender_repid_before: defBefore, defender_repid_after: defBefore + deltaDef, defender_repid_delta: deltaDef,
    bft_votes: null, latency_ms: 0, provider_used: 'adjudication', false_positive: falsePositive,
  };
  const { data, error } = await db.from('red_team_results').insert(row).select('id').maybeSingle();
  if (error) throw new Error(`red_team_results insert failed: ${error.message}`);

  // Bridge each moved agent to the ERC-8004 outbox so a real red-team catch
  // reaches the chain via FeedbackLoopWorker. Flag-gated (default OFF) + best-
  // effort inside the helper — never fails the adjudication. Only agents that
  // resolved to a uuid can be snapshotted on-chain.
  const outboxEvent = CASE_TO_OUTBOX_EVENT[input.case];
  for (const d of deltas) {
    if (!d.agentId) continue;
    await emitOnChainOutboxEvent({
      subjectAgentId: d.agentId,
      eventType: outboxEvent,
      reputationDelta: d.delta,
      context: { challenge_id: input.challenge_id, redteam_case: input.case, role: d.role },
    });
  }

  return { case: input.case, challenge_id: input.challenge_id, deltas, red_team_result_id: (data as any)?.id ?? null };
}
