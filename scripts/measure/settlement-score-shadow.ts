/**
 * settlement-score-shadow measurement — READ ONLY.
 *
 * Answers the one question a settlement-scoring flip needs answered first: for
 * the `settled` service_contracts that ALREADY exist, what score change would
 * the satisfied leg have produced, for whom, and how many of them never got it?
 *
 * It SELECTs only. It never inserts or updates any table, and in particular
 * never touches `repid_agents` or `repid_score_events`. The would-be delta is
 * computed by the SAME pure function the shadow observer uses
 * (`computeSettlementScoreDeltas`), which reproduces `applyServiceSatisfiedDeltas`
 * exactly — so this table and a future live apply cannot disagree by arithmetic.
 *
 *   npx ts-node scripts/measure/settlement-score-shadow.ts          # markdown table
 *   npx ts-node scripts/measure/settlement-score-shadow.ts --json   # raw JSON
 *
 * Requires read credentials (SUPABASE_URL + a service key) in the environment,
 * exactly as any other read against prod. The NAIVE after-value it prints is
 * `current_repid + delta` WITHOUT decay, the [10,10000] clamp, or the money-path
 * gate — labelled as such, because those are the live writer's job, not a copy's.
 */
import { db } from '../../src/db';
import {
  computeSettlementScoreDeltas,
} from '../../src/services/settlement-score-shadow';
import { contractRowIsSimulated } from '../../src/services/validation-repid-delta';

interface Row {
  contract_id: string;
  provider: string;
  buyer: string;
  satisfaction: number | null;
  is_simulated: boolean;
  already_scored: boolean;
  provider_delta: number;
  buyer_delta: number;
  provider_repid_before: number | null;
  buyer_repid_before: number | null;
}

async function nameFor(agentId: string, cache: Map<string, { name: string; repid: number | null }>) {
  if (cache.has(agentId)) return cache.get(agentId)!;
  const { data } = await db.from('repid_agents').select('agent_name, current_repid').eq('id', agentId).maybeSingle();
  const entry = {
    name: (data as any)?.agent_name ?? agentId,
    repid: typeof (data as any)?.current_repid === 'number' ? (data as any).current_repid : null,
  };
  cache.set(agentId, entry);
  return entry;
}

async function main() {
  const asJson = process.argv.includes('--json');

  const { data: contracts, error } = await db
    .from('service_contracts')
    .select('id, provider_agent_id, buyer_agent_id, buyer_satisfaction_score, metadata, payload, x402_payment_id, settled_at')
    .eq('status', 'settled')
    .order('settled_at', { ascending: false });

  if (error) {
    console.error('[measure] settled-contract read failed:', error.message);
    process.exit(2);
  }

  const cache = new Map<string, { name: string; repid: number | null }>();
  const rows: Row[] = [];

  for (const c of (contracts ?? []) as any[]) {
    const isSimulated = await contractRowIsSimulated({
      metadata: c.metadata ?? {},
      payload: c.payload ?? {},
      x402_payment_id: c.x402_payment_id ?? null,
    });
    const deltas = computeSettlementScoreDeltas({ satisfactionScore: c.buyer_satisfaction_score, isSimulated });

    // Has the satisfied leg already been recorded for this contract?
    const { data: ev } = await db
      .from('repid_score_events')
      .select('id')
      .eq('event_type', 'SERVICE_SATISFIED')
      .eq('contract_id', c.id)
      .limit(1);
    const already_scored = Array.isArray(ev) && ev.length > 0;

    const provider = await nameFor(c.provider_agent_id, cache);
    const buyer = await nameFor(c.buyer_agent_id, cache);

    rows.push({
      contract_id: c.id,
      provider: provider.name,
      buyer: buyer.name,
      satisfaction: c.buyer_satisfaction_score,
      is_simulated: isSimulated,
      already_scored,
      provider_delta: deltas.providerDelta,
      buyer_delta: deltas.buyerDelta,
      provider_repid_before: provider.repid,
      buyer_repid_before: buyer.repid,
    });
  }

  const gap = rows.filter((r) => !r.already_scored);
  const summary = {
    settled_contracts: rows.length,
    already_scored: rows.filter((r) => r.already_scored).length,
    unscored_gap: gap.length,
    simulated: rows.filter((r) => r.is_simulated).length,
    sum_provider_would_delta_in_gap: gap.reduce((s, r) => s + r.provider_delta, 0),
    sum_buyer_would_delta_in_gap: gap.reduce((s, r) => s + r.buyer_delta, 0),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    return;
  }

  console.log('# Settlement-score shadow — settled contracts (READ ONLY)\n');
  console.log(`settled=${summary.settled_contracts}  already_scored=${summary.already_scored}  ` +
    `unscored_gap=${summary.unscored_gap}  simulated=${summary.simulated}`);
  console.log(`gap would apply: provider Σ=${summary.sum_provider_would_delta_in_gap}  ` +
    `buyer Σ=${summary.sum_buyer_would_delta_in_gap}  (raw satisfied deltas; live apply adds decay+clamp+gate)\n`);
  console.log('| contract | provider | buyer | satisfaction | sim | already_scored | prov Δ | buyer Δ |');
  console.log('|---|---|---|---:|:-:|:-:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.contract_id.slice(0, 8)} | ${r.provider} | ${r.buyer} | ${r.satisfaction ?? 'null'} | ` +
      `${r.is_simulated ? 'Y' : 'n'} | ${r.already_scored ? 'Y' : 'n'} | ${r.provider_delta} | ${r.buyer_delta} |`,
    );
  }
}

main().catch((e) => {
  console.error('[measure] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
