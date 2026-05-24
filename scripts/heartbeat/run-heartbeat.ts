/**
 * run-heartbeat.ts — continuous economic-loop smoke test (CC1, 2026-05-25).
 *
 * Hourly liveness probe of the deployed pipeline: seeds a SIMULATED service
 * contract and verifies it flows escrowed → fulfilled → HAL → bridge, recording
 * per-phase latency + pass/fail to telemetry (metric_family='heartbeat').
 *
 *   ts-node scripts/heartbeat/run-heartbeat.ts
 *   ts-node scripts/heartbeat/run-heartbeat.ts --no-cleanup   # leave hb- rows for inspection
 *
 * HARD SAFETY CAP: is_simulated=true at every layer. The probe NEVER sends an
 * X-PAYMENT, NEVER calls settle, NEVER moves money. The defensive filter guarantees
 * a simulated fulfillment cannot produce an on-chain write; the probe additionally
 * ASSERTS no erc8004 write references its contract. Self-cleans its hb- rows.
 * Exit 0 if all phases pass, 1 otherwise (so a scheduler can alert).
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const sb = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) as string,
);

const HB_PREFIX = 'hb-';
// SAFETY: the cascade still applies a real +RepID delta on SERVICE_FULFILLED even for
// is_simulated contracts (finding 2026-05-25 → Gemini/CC2 to gate delta on !is_simulated).
// Until that's fixed, the heartbeat MUST use a DEDICATED throwaway provider so it never
// inflates a real agent's reputation. Set HEARTBEAT_PROVIDER_AGENT_ID to that agent's id.
// The probe refuses to run (no-op) if it's unset or points at an on-chain (tokened) agent.
const PROVIDER_ID = process.env.HEARTBEAT_PROVIDER_AGENT_ID || '';
const BUYER_ID = process.env.HEARTBEAT_BUYER_AGENT_ID || 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067'; // trinity-veritas
const SERVICE_ID = '0edfc364-ad2a-4b3a-bdc4-20b03ab92e21';
const CASCADE_TIMEOUT_MS = 90_000;
const POLL_MS = 5_000;
const NO_CLEANUP = process.argv.includes('--no-cleanup');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Phase = { name: string; success: boolean; duration_ms: number; detail?: any };

export async function runHeartbeat() {
  const started = Date.now();
  const tag = `${HB_PREFIX}${Date.now()}`;
  const phases: Phase[] = [];
  let contractId: string | null = null;
  const t = () => Date.now();

  const record = (name: string, ok: boolean, t0: number, detail?: any) =>
    phases.push({ name, success: ok, duration_ms: t() - t0, detail });

  // SAFETY GATE — refuse to inject unless a dedicated, non-on-chain provider is configured.
  if (!PROVIDER_ID) {
    return { tag, contract_id: null, started_at: new Date(started).toISOString(), total_duration_ms: 0,
      all_success: false, skipped: true,
      phases: [{ name: 'safety_gate', success: false, duration_ms: 0,
        detail: { reason: 'HEARTBEAT_PROVIDER_AGENT_ID unset — refusing to inject (would inflate a real agent\'s RepID). Provision a dedicated throwaway agent first.' } }] };
  }
  try {
    const { data: prov } = await sb.from('repid_agents').select('erc8004_token_id,agent_name').eq('id', PROVIDER_ID).maybeSingle();
    if (prov?.erc8004_token_id) {
      return { tag, contract_id: null, started_at: new Date(started).toISOString(), total_duration_ms: 0,
        all_success: false, skipped: true,
        phases: [{ name: 'safety_gate', success: false, duration_ms: 0,
          detail: { reason: `provider ${prov.agent_name} has erc8004_token_id — refusing (on-chain/economic agent). Use a dedicated throwaway provider.` } }] };
    }
  } catch { /* fall through — DB check failure handled below */ }

  try {
    // Phase 1 — create a SIMULATED contract (insert pending per schema constraint,
    // then transition to escrowed with a sim settlement). Hard sim cap throughout.
    let p0 = t();
    const { data: contract, error: cErr } = await sb.from('service_contracts').insert({
      service_id: SERVICE_ID, buyer_agent_id: BUYER_ID, provider_agent_id: PROVIDER_ID,
      agreed_price_usdc_raw: 1, status: 'pending',
      payload: { title: tag, service_type: 'verification', task_type: 'verification',
                 content: 'Heartbeat liveness check: water boils at 100C at sea level.', criteria: ['accuracy'] },
      metadata: { heartbeat: true, is_simulated: true },
    }).select('id').single();
    if (cErr) throw new Error(`create: ${cErr.message}`);
    contractId = contract.id;
    // sim settlement (is_simulated=true — NEVER real)
    const { data: settle, error: sErr } = await sb.from('x402_settlements').insert({
      tip_id: `contract_${contractId}`, idempotency_key: contractId, prediction_topic: 'verification',
      amount: 1, asset: 'USDC', status: 'settled', is_simulated: true,
      provider_agent_id: PROVIDER_ID, requestor_agent_id: BUYER_ID,
      x_payment_header: `${tag}-sim`, delivered_at: new Date().toISOString(), settlement_attempt_count: 1,
    }).select('id').single();
    if (sErr) throw new Error(`sim-settlement: ${sErr.message}`);
    // transition pending → escrowed (the cascade worker drives escrowed → fulfilled)
    const { error: uErr } = await sb.from('service_contracts')
      .update({ status: 'escrowed', x402_payment_id: settle.id, escrowed_at: new Date().toISOString() })
      .eq('id', contractId);
    if (uErr) throw new Error(`escrow-transition: ${uErr.message}`);
    record('create_simulated_contract', true, p0, { contractId });

    // Phase 2 — cascade: poll for escrowed → fulfilled.
    p0 = t(); let fulfilled = false;
    const deadline = Date.now() + CASCADE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { data } = await sb.from('service_contracts').select('status,result').eq('id', contractId).maybeSingle();
      if (data?.status === 'fulfilled') { fulfilled = true; break; }
      await sleep(POLL_MS);
    }
    record('cascade_fulfillment', fulfilled, p0, fulfilled ? {} : { note: 'cascade did not fulfill within timeout (worker enabled?)' });

    // Phase 3 — HAL: a score event with hal_decision appeared for this provider since start.
    p0 = t();
    const { data: se } = await sb.from('repid_score_events').select('id,hal_decision,created_at')
      .eq('agent_id', PROVIDER_ID).gte('created_at', new Date(started).toISOString())
      .not('hal_decision', 'is', null).order('created_at', { ascending: false }).limit(1);
    record('hal_evaluation', !!(se && se.length), p0, se && se.length ? { hal_decision: se[0].hal_decision } : {});

    // Phase 4 — bridge: a service_fulfilled_settled event for this provider, flagged simulated.
    p0 = t();
    const { data: ev } = await sb.from('repid_events').select('id,event_data,created_at')
      .eq('event_type', 'service_fulfilled_settled').eq('subject_id', PROVIDER_ID)
      .gte('created_at', new Date(started).toISOString()).order('created_at', { ascending: false }).limit(1);
    record('bridge_event', !!(ev && ev.length), p0, ev && ev.length ? { id: ev[0].id } : {});

    // Phase 5 — SAFETY INVARIANT: no on-chain write may reference this heartbeat contract.
    p0 = t();
    const { data: leak } = await sb.from('repid_events').select('id,event_data')
      .eq('event_type', 'service_fulfilled_settled').gte('created_at', new Date(started).toISOString());
    const onchainLeak = (leak || []).some((e: any) =>
      (e.event_data?.metadata?.contract_id === contractId || e.event_data?.contract_id === contractId)
      && e.event_data?.reputation_tx_hash && !/^0x(mock|abc|0{8})/i.test(e.event_data.reputation_tx_hash));
    record('no_onchain_leak', !onchainLeak, p0, { onchainLeak });
  } catch (e: any) {
    record('error', false, started, { error: e.message });
  } finally {
    // Cleanup hb- rows (unless --no-cleanup).
    if (contractId && !NO_CLEANUP) {
      await sb.from('x402_settlements').delete().eq('idempotency_key', contractId);
      await sb.from('service_contracts').delete().eq('id', contractId);
    }
  }

  const all_success = phases.length > 0 && phases.every(p => p.success);
  const result = { tag, contract_id: contractId, started_at: new Date(started).toISOString(),
    total_duration_ms: Date.now() - started, all_success, phases };

  // Record telemetry (table-optional).
  try {
    await sb.from('repid_telemetry_snapshots').insert({
      metric_family: 'heartbeat', metric_name: 'loop_smoke',
      metric_value: result, metadata: { cleaned: !NO_CLEANUP },
    });
  } catch { /* table not yet created — non-fatal */ }
  return result;
}

if (require.main === module) {
  runHeartbeat()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.all_success ? 0 : 1); })
    .catch(e => { console.error('heartbeat crashed:', e.message); process.exit(1); });
}
