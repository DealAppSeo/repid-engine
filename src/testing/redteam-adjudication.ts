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

export interface AppliedDelta { agent: string; role: 'finder' | 'subject' | 'accuser'; delta: number; before: number; after: number; event_type: string; }
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
  const metadata = { ...meta, redteam: true, role, agent_name: agent, source: 'S-REDTEAM-R2' };

  // v3.1 — penalties (delta < 0) go through the atomic RPC: ONE txn inserts the audit row (repid_delta_applied
  // pre-set so trg_apply_repid_score_event no-ops) + bypass-applies + sets floor_override on sub-floor demotion.
  // This is what makes a red-team slash actually persist on a high-peak agent instead of being re-floored.
  if (id && delta < 0) {
    const newRepid = Math.max(0, Math.round(before + delta));
    const { error: rpcErr } = await db.rpc('apply_repid_penalty', {
      p_agent: id,
      p_new_repid: newRepid,
      p_event: {
        event_type: eventType, delta, repid_delta_calculated: delta,
        // v3.1.1 — deterministic idempotency key (source-tied): a re-adjudication of the same
        // challenge/role/agent is a no-op, never a second slash. (RPC now REQUIRES a non-null key.)
        idempotency_key: `redteam:${meta?.challenge_id ?? 'na'}:${role}:${agent}`,
        metadata,
      },
    });
    if (rpcErr) throw new Error(`apply_repid_penalty failed for ${agent}: ${rpcErr.message}`);
    const after = (await resolveAgent(agent)).current_repid; // read back post-trigger value
    return { agent, role, delta, before, after, event_type: eventType };
  }

  // Positive (finder reward) / unresolved-id path unchanged: direct apply + audit insert; trg enforces the floor.
  await db.from('repid_agents').update({ current_repid: Math.max(0, Math.round(before + delta)), last_updated: new Date().toISOString() }).eq('agent_name', agent);
  const after = (await resolveAgent(agent)).current_repid; // read back the post-trigger value
  const { error } = await db.from('repid_score_events').insert({
    agent_id: id, event_type: eventType,
    delta, repid_before: before, repid_after: after,
    metadata,
  });
  if (error) throw new Error(`repid_score_events insert failed for ${agent}: ${error.message}`);
  return { agent, role, delta, before, after, event_type: eventType };
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
  return { case: input.case, challenge_id: input.challenge_id, deltas, red_team_result_id: (data as any)?.id ?? null };
}
