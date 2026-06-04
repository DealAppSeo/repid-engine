/**
 * S-R4 Phase 3 — Adversarial x402 E2E (instant-settle + reputation consequence).
 *
 * "Watch them try to cheat, watch it get caught." Each exchange: instant-settle an x402 micropayment
 * (GA's settleX402Payment, mock when unfunded), evaluate delivery/payment, then apply the reputation
 * consequence and record artifacts to the ledgers:
 *   - take_and_run   : provider is PAID but delivers nothing (artifact NO_ARTIFACT_SAVED) → provider RepID dock
 *   - deliver_and_stiff: consumer gets the service but underpays vs the agreed contract → consumer RepID dock
 *   - honest         : delivered + paid in full → both rise (small reward)
 * Fraud findings → red_team_results (via adjudicate); every exchange → t12_e2e_proofs (x402 tx + RepID
 * event id; EAS null-safe). Cross-FAMILY attacker rotation (grok/deepseek/qwen/chatgpt) is labelled on
 * the attacker so adversaries are not self-grading; behaviours are scripted (live external-LLM
 * generation is provider-throttle-blocked this round — recorded honestly in metadata.adversary_family).
 *
 * Every row is tagged test_run_id and revertible. Uses synthetic agents only (never real trinity).
 */
import { db } from '../db';
import { settleX402Payment } from '../services/x402-real-settler';
import { adjudicate } from './redteam-adjudication';

export type Scenario = 'take_and_run' | 'deliver_and_stiff' | 'honest';

export interface Exchange {
  runId: string;
  provider: string;            // synthetic agent_name
  consumer: string;            // synthetic agent_name
  scenario: Scenario;
  amountUsdc: number;          // what was actually paid
  agreedPriceUsdc?: number;    // contract price (deliver_and_stiff: amount < agreed = debt)
  adversaryFamily?: string;    // grok | deepseek | qwen | chatgpt (rotation label)
}

export interface ExchangeResult {
  scenario: Scenario;
  caught: boolean;
  fraudster: string | null;
  fraudster_delta: number;
  x402_tx_hash: string | null;
  x402_source: string | null;
  t12_id: number | null;
  red_team_id: number | null;
  transcript: string;
}

async function resolveId(agent: string): Promise<string | null> {
  const { data } = await db.from('repid_agents').select('id').eq('agent_name', agent).maybeSingle();
  return (data as any)?.id ?? null;
}

/** Small honest reward through the canonical path (SERVICE_FULFILLED is whitelisted). */
async function reward(agent: string, delta: number, meta: any): Promise<number | null> {
  const id = await resolveId(agent);
  const { data: a } = await db.from('repid_agents').select('current_repid').eq('agent_name', agent).maybeSingle();
  const before = (a as any)?.current_repid ?? 100;
  await db.from('repid_agents').update({ current_repid: Math.max(0, Math.round(before + delta)), last_updated: new Date().toISOString() }).eq('agent_name', agent);
  const { data: a2 } = await db.from('repid_agents').select('current_repid').eq('agent_name', agent).maybeSingle();
  const after = (a2 as any)?.current_repid ?? before;
  const { data } = await db.from('repid_score_events').insert({ agent_id: id, event_type: 'SERVICE_FULFILLED', delta, repid_before: before, repid_after: after, metadata: { ...meta, source: 'S-ADVERSARIAL-E2E' } }).select('id').maybeSingle();
  return (data as any)?.id ?? null;
}

export async function runExchange(ex: Exchange): Promise<ExchangeResult> {
  const cid = `adv-${ex.scenario}-${ex.runId}`;
  // 1. Instant-settle the x402 micropayment (mock when unfunded; null-safe).
  const settle = await settleX402Payment(ex.consumer, ex.provider, Math.min(ex.amountUsdc, 1.0), cid).catch((e: any) => ({ settlement_source: `error:${e?.message ?? e}`.slice(0, 60) } as any));
  const x402_tx_hash = (settle as any).tx_hash ?? null;
  const x402_source = (settle as any).settlement_source ?? null;

  let caught = false, fraudster: string | null = null, fraudster_delta = 0, red_team_id: number | null = null;
  let repid_event_id: number | null = null, transcript = '';

  if (ex.scenario === 'take_and_run') {
    // Provider was paid, delivered nothing.
    const adj = await adjudicate({ case: 'lazy_subject', challenge_id: cid, finder: ex.consumer, subject: ex.provider, artifact_url: 'NO_ARTIFACT_SAVED', substance_passed: false });
    caught = true; fraudster = ex.provider; red_team_id = adj.red_team_result_id;
    fraudster_delta = adj.deltas.find((d) => d.role === 'subject')?.delta ?? 0;
    repid_event_id = null;
    transcript = `[${ex.adversaryFamily ?? 'attacker'}] provider ${ex.provider} took ${ex.amountUsdc} USDC (tx ${x402_tx_hash ?? 'pending'}), delivered NO_ARTIFACT_SAVED → CAUGHT: RepID ${fraudster_delta}, access gate down`;
  } else if (ex.scenario === 'deliver_and_stiff') {
    const agreed = ex.agreedPriceUsdc ?? ex.amountUsdc;
    const debt = agreed - ex.amountUsdc;
    if (debt > 0) {
      const adj = await adjudicate({ case: 'good_catch', challenge_id: cid, finder: ex.provider, subject: ex.consumer, evidence: `contract ${agreed} USDC but paid ${ex.amountUsdc} → debt ${debt}` });
      caught = true; fraudster = ex.consumer; red_team_id = adj.red_team_result_id;
      fraudster_delta = adj.deltas.find((d) => d.role === 'subject')?.delta ?? 0;
      transcript = `[${ex.adversaryFamily ?? 'attacker'}] consumer ${ex.consumer} received service, paid ${ex.amountUsdc}/${agreed} USDC (debt ${debt}) → CAUGHT: RepID ${fraudster_delta}`;
    } else {
      transcript = `consumer ${ex.consumer} paid in full (${ex.amountUsdc}/${agreed}) — honest`;
    }
  } else {
    // honest: both sides reward
    repid_event_id = await reward(ex.provider, 3, { challenge_id: cid, role: 'honest_provider' });
    await reward(ex.consumer, 1, { challenge_id: cid, role: 'honest_consumer' });
    transcript = `provider ${ex.provider} delivered, consumer ${ex.consumer} paid ${ex.amountUsdc} in full → both RewardED`;
  }

  // 2. Record the E2E proof-ledger row (x402 tx + RepID consequence; EAS null-safe).
  const stages_real = { verify: true, x402: x402_source === 'onchain_x402' && !!x402_tx_hash && !/^0xmock/.test(x402_tx_hash || ''), repid: caught || repid_event_id !== null, eas: false };
  const { data: t12 } = await db.from('t12_e2e_proofs').insert({
    run_id: ex.runId, agent_name: ex.scenario === 'take_and_run' ? ex.provider : ex.consumer,
    output_text: transcript.slice(0, 2000), hal_score: null, hal_verdict: ex.scenario,
    x402_tx_hash, x402_payment_id: cid, x402_chain_id: 84532,
    repid_event_id, repid_delta: fraudster_delta || (ex.scenario === 'honest' ? 3 : 0),
    zkp_proof_id: null, eas_attestation_uid: null,
    proof_status: stages_real.x402 && stages_real.eas ? 'complete' : 'partial', stages_real,
    metadata: { scenario: ex.scenario, caught, fraudster, adversary_family: ex.adversaryFamily ?? null, x402_source, test_run: true },
  }).select('id').maybeSingle();

  return { scenario: ex.scenario, caught, fraudster, fraudster_delta, x402_tx_hash, x402_source, t12_id: (t12 as any)?.id ?? null, red_team_id, transcript };
}
