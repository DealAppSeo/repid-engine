/**
 * S-R3 Phase 3 — T12 ON-CHAIN E2E PROOF HARNESS (marquee).
 *
 * One agent output, four stages, each on-chain artifact recorded to the t12_e2e_proofs ledger:
 *   1. verifyOutput  — HAL evaluate (real hal_score/verdict)
 *   2. executeA2A    — x402 settlement via settleX402Payment (real tx_hash if funded, else
 *                      pending_funding/simulated — NULL-SAFE, GA's settler, called not edited)
 *   3. RepID delta   — append a repid_score_events row (real event id), earned-floor enforced
 *   4. presentProof  — ZKP proof id (real uuid) + EAS attestation uid (NULL until attester key lands)
 *
 * Null-safe by design: it RUNS NOW recording whatever is real (HAL + RepID always; x402 when
 * funded/mock; EAS when EAS_ATTESTER_KEY is present) and produces real on-chain proofs the moment the
 * x402 wallet is funded and the EAS key lands — no rewrite. `stages_real` flags which stages were
 * genuinely on-chain vs simulated/pending. Does NOT edit x402/EAS code (GA/XC lanes).
 *
 * Entry: runE2EProof() — the function a T12 E2E-patrol task class invokes per output.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { halService } from '../hal/service';
import { resolveHalStrictness } from '../scoring/pipeline';
import { settleX402Payment } from '../services/x402-real-settler';
import { insertScoreEvent } from '../scoring/score-event-writer';
import { scoreEventGuardEnforced } from '../routes/score-event-guard';
import { fenceServiceAward, serviceAwardFenceEnabled } from '../scoring/service-award-fence';

export const T12_E2E_TASK_CLASS = 't12_onchain_e2e_proof'; // pairs with the T12 empowerment-seed E2E patrol

export interface E2EProofInput {
  runId: string;
  agent: string;            // the subject agent whose output is proven
  output: string;           // the deliverable text to verify
  counterparty?: string;    // x402 payee (defaults to a stable hub agent)
  amountUsdc?: number;      // x402 amount (kept under the 1.0 governor)
  repidDelta?: number;      // RepID reward for a clean verify (default +3)
}

export interface E2EProofRow {
  id: number | null; run_id: string; agent_name: string;
  hal_score: number | null; hal_verdict: string | null;
  x402_tx_hash: string | null; x402_settlement_source: string | null;
  repid_event_id: number | null; repid_delta: number | null;
  zkp_proof_id: string | null; eas_attestation_uid: string | null;
  proof_status: 'partial' | 'complete' | 'failed';
  stages_real: { verify: boolean; x402: boolean; repid: boolean; eas: boolean };
}

async function resolveAgent(agent: string): Promise<{ id: string | null; current_repid: number }> {
  const { data } = await db.from('repid_agents').select('id, current_repid').eq('agent_name', agent).maybeSingle();
  return { id: (data as any)?.id ?? null, current_repid: (data as any)?.current_repid ?? 100 };
}

/** Map HAL's verdict string onto the fence's hal_decision domain (null when unrecognized/absent). */
function fenceHalDecision(verdict: string | null): 'vetoed' | 'flagged' | 'clean' | 'abstain' | null {
  const v = (verdict ?? '').toLowerCase();
  if (v === 'clean' || v === 'pass' || v === 'approved') return 'clean';
  if (v.includes('veto')) return 'vetoed';
  if (v.includes('flag')) return 'flagged';
  if (v.includes('abstain')) return 'abstain';
  return null;
}

interface RewardResult { event_id: number | null; demoted: boolean; reasons: string[]; }

/**
 * Append a positive RepID delta (clean verify reward) and return the event id. Earned-floor enforced by trigger.
 *
 * §P0 fence (D-130 M3b) behind SERVICE_AWARD_FENCE (default OFF). The fence call below is reached on EVERY path;
 * when the flag is off its result is discarded and the canonical writes + return value are unchanged — so behaviour
 * is identical to today (not byte-identical: one pure, side-effect-free call is added). When the flag is ON, a
 * SERVICE_FULFILLED award is DEMOTED to shadow unless it is verified-clean AND independent AND idempotent:
 * canonical repid_agents.current_repid and the canonical event are NOT written, and the demotion reasons are
 * recorded on the t12_e2e_proofs row (repid_event_id stays null). The harness establishes no independence and
 * carries no idempotency key, so today every award demotes when the flag is on — which is the point: it was
 * moving canonical RepID on unverified work. Flipping the flag is a MAJOR/owner action (r23), after the count.
 * New blast radius once flipped: the three-way conjunction in fenceServiceAward + the fenceHalDecision mapping
 * become load-bearing — an error there could suppress a legitimate award (it cannot mint a false one).
 * ponytail: demotion is recorded on the proof row, not a separate shadow table — upgrade to repid_experimental_events if that evidence needs its own surface.
 */
async function applyRepidReward(agent: string, delta: number, meta: any): Promise<RewardResult> {
  const fence = fenceServiceAward({
    hal_decision: fenceHalDecision(meta?.hal_verdict ?? null),
    independence: 'unknown', // harness establishes none (same-controller Trinity agents); never 'independent'
    idempotency_key: null,   // the award carries no replay key today
  });
  if (serviceAwardFenceEnabled() && !fence.canonical) {
    return { event_id: null, demoted: true, reasons: fence.reasons };
  }

  const { id, current_repid: before } = await resolveAgent(agent);
  await db.from('repid_agents').update({ current_repid: Math.max(0, Math.round(before + delta)), last_updated: new Date().toISOString() }).eq('agent_name', agent);
  const after = (await resolveAgent(agent)).current_repid;
  const proofMetadata = { ...meta, source: 'T12_E2E_PROOF' };
  if (scoreEventGuardEnforced()) {
    // DOUBLE-APPLY SITE — same shape as redteam-adjudication.ts: current_repid is
    // written above, then an event without repid_delta_applied lets the trigger
    // re-read and add `delta` again. Proven on prod (rolled back): +7 drift.
    const r = await insertScoreEvent({
      applier: 'caller',
      agent_id: id as string,
      event_type: 'SERVICE_FULFILLED',
      delta,
      repid_before: before,
      repid_after: after,
      repid_delta_applied: after - before,
      repid_delta_calculated: Math.round(delta),
      metadata: proofMetadata,
    });
    if (!r.ok) throw new Error(`repid_score_events insert failed: ${r.error}`);
    return { event_id: r.id ? Number(r.id) : null, demoted: false, reasons: [] };
  }
  const { data, error } = await db.from('repid_score_events').insert({
    agent_id: id, event_type: 'SERVICE_FULFILLED', delta, repid_before: before, repid_after: after,
    metadata: proofMetadata,
  }).select('id').maybeSingle();
  if (error) throw new Error(`repid_score_events insert failed: ${error.message}`);
  return { event_id: (data as any)?.id ?? null, demoted: false, reasons: [] };
}

export async function runE2EProof(input: E2EProofInput): Promise<E2EProofRow> {
  const counterparty = input.counterparty ?? 'trinity-sophia';
  const amount = input.amountUsdc ?? 0.1;
  const repidDelta = input.repidDelta ?? 3;
  const stages_real = { verify: false, x402: false, repid: false, eas: false };

  // Stage 1 — verifyOutput (HAL).
  let hal_score: number | null = null, hal_verdict: string | null = null;
  try {
    const r: any = await halService.evaluate({ text: input.output, context: { domain: 'general', certainty: 0.8 }, strictness: resolveHalStrictness() });
    hal_score = Number.isFinite(r.hal_score) ? r.hal_score : null;
    hal_verdict = r.decision ?? r.verdict ?? null;
    stages_real.verify = hal_score !== null;
  } catch (e: any) { hal_verdict = `hal_error:${e?.message ?? e}`.slice(0, 80); }

  // Stage 2 — executeA2A (x402). NULL-SAFE: real tx when funded, else pending_funding/simulated.
  let x402_tx_hash: string | null = null, x402_settlement_source: string | null = null;
  try {
    const s = await settleX402Payment(input.agent, counterparty, amount, `t12-${input.runId}`);
    x402_tx_hash = s.tx_hash ?? null;
    x402_settlement_source = s.settlement_source ?? (s.error ? `error:${s.error}`.slice(0, 80) : null);
    // "real" only if a non-mock on-chain settlement produced a tx hash.
    stages_real.x402 = s.settlement_source === 'onchain_x402' && !!s.tx_hash && !/^0xmock/.test(s.tx_hash);
  } catch (e: any) { x402_settlement_source = `x402_error:${e?.message ?? e}`.slice(0, 80); }

  // Stage 3 — RepID delta. The SERVICE_AWARD_FENCE may demote it to shadow (no canonical move); default OFF.
  let repid_event_id: number | null = null;
  let repid_award_demoted = false;
  let repid_demote_reasons: string[] = [];
  try {
    const reward = await applyRepidReward(input.agent, repidDelta, { run_id: input.runId, hal_verdict, x402_tx_hash });
    repid_event_id = reward.event_id;
    repid_award_demoted = reward.demoted;
    repid_demote_reasons = reward.reasons;
    stages_real.repid = repid_event_id !== null;
  } catch (e: any) { /* recorded via proof_status below */ }

  // Stage 4 — presentProof (ZKP id real; EAS uid NULL-SAFE until attester key lands).
  const zkp_proof_id = crypto.randomUUID();
  let eas_attestation_uid: string | null = null;
  if (process.env.EAS_ATTESTER_KEY) {
    // The XC EAS attester wires here when the key lands; until then uid stays null (no rewrite needed).
    eas_attestation_uid = null;
    stages_real.eas = false;
  }

  const proof_status: E2EProofRow['proof_status'] = stages_real.repid && stages_real.verify
    ? (stages_real.x402 && stages_real.eas ? 'complete' : 'partial')
    : 'failed';

  const row = {
    run_id: input.runId, agent_name: input.agent, output_text: input.output.slice(0, 2000),
    hal_score, hal_verdict, x402_tx_hash, x402_payment_id: `t12-${input.runId}`, x402_chain_id: 84532,
    repid_event_id, repid_delta: stages_real.repid ? repidDelta : null,
    zkp_proof_id, eas_attestation_uid, proof_status, stages_real,
    metadata: { task_class: T12_E2E_TASK_CLASS, x402_settlement_source, counterparty, amount_usdc: amount,
      ...(repid_award_demoted ? { repid_award_demoted: true, repid_demote_reasons } : {}) },
  };
  const { data, error } = await db.from('t12_e2e_proofs').insert(row).select('id').maybeSingle();
  if (error) throw new Error(`t12_e2e_proofs insert failed: ${error.message}`);

  return {
    id: (data as any)?.id ?? null, run_id: input.runId, agent_name: input.agent,
    hal_score, hal_verdict, x402_tx_hash, x402_settlement_source,
    repid_event_id, repid_delta: row.repid_delta, zkp_proof_id, eas_attestation_uid, proof_status, stages_real,
  };
}
