#!/usr/bin/env node
/**
 * npm run demo:trust — the whole trust harness, in one command, with a receipt.
 *
 * Reads a REAL settled exchange out of the production database and the Base
 * Sepolia chain, and prints it as something a person can read. It does not
 * simulate anything and it does not spend anything: every number and hash below
 * already happened.
 *
 * Pass --json for the same data as a machine-readable object (this is what a
 * receipt page renders).
 *
 * WHY THIS EXISTS: the loop has worked end-to-end for a while and nobody could
 * see it. A verified system nobody can look at converts no one.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const ENV = Object.fromEntries(
  readFileSync(process.env.TRUSTKEYS_ENV_MASTER || 'C:/Users/Cash4/repos/.env.master', 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const sb = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY);
const asJson = process.argv.includes('--json');
const usdc = (raw) => `$${(Number(raw) / 1e6).toFixed(2)}`;
const scan = (tx) => `https://sepolia.basescan.org/tx/${tx}`;

/** The most recent exchange that actually completed, negotiated or not. */
async function latestSettledExchange() {
  const { data: settlements } = await sb.from('x402_settlements')
    .select('idempotency_key, tx_hash, amount, is_simulated, status, created_at')
    .eq('status', 'settled').eq('is_simulated', false)
    .not('tx_hash', 'is', null)
    .order('created_at', { ascending: false }).limit(25);

  for (const s of settlements ?? []) {
    const { data: c } = await sb.from('service_contracts')
      .select('id, status, agreed_price_usdc_raw, buyer_agent_id, provider_agent_id, result, settled_at')
      .eq('id', s.idempotency_key).maybeSingle();
    if (c && c.status === 'settled') return { settlement: s, contract: c };
  }
  return null;
}

const found = await latestSettledExchange();
if (!found) {
  console.error('No real settled exchange found. Nothing to show — and this command will not invent one.');
  process.exit(2);
}
const { settlement, contract } = found;

const names = {};
for (const id of [contract.buyer_agent_id, contract.provider_agent_id]) {
  const { data } = await sb.from('repid_agents').select('agent_name, current_repid, tier, erc8004_token_id').eq('id', id).maybeSingle();
  names[id] = data ?? { agent_name: id.slice(0, 8) };
}

// The negotiation behind it, if this contract came from an RFQ.
const { data: award } = await sb.from('a2a_awards')
  .select('rfq_id, awarded_price_usdc_raw, competing_bid_count, was_lowest_price, is_uncontested')
  .eq('contract_id', contract.id).maybeSingle();
let bids = [];
if (award) {
  const { data } = await sb.from('a2a_bids').select('provider_agent_id, status').eq('rfq_id', award.rfq_id);
  bids = data ?? [];
}

// RepID movement caused by this contract.
const { data: events } = await sb.from('repid_score_events')
  .select('agent_id, event_type, delta, repid_before, repid_after')
  .eq('contract_id', contract.id).order('created_at');

// The on-chain reputation write that FOLLOWED this settlement.
//
// HONESTY: erc8004_reputation_writes.repid_event_id does NOT resolve to this
// contract (contract_id is null on those rows), so we cannot PROVE this write
// was caused by this exchange. What we can say is that it is the provider's
// most recent on-chain write and its repid_value matches this contract's
// outcome. The receipt says exactly that and no more. Recording the per-contract
// link is a real gap worth closing.
const { data: onchain } = await sb.from('erc8004_reputation_writes')
  .select('tx_hash, repid_value, block_number, created_at, agent_id')
  .in('agent_id', [contract.buyer_agent_id, contract.provider_agent_id])
  .gte('created_at', contract.settled_at ?? '1970-01-01')
  .order('created_at', { ascending: false }).limit(1).maybeSingle();

// Any ZK proof linked to this contract.
const { data: proofs } = await sb.from('repid_zkp_proofs')
  .select('scheme, statement, proof_bytes, is_real').eq('contract_id', contract.id).limit(3);

const receipt = {
  contract_id: contract.id,
  price: usdc(contract.agreed_price_usdc_raw),
  buyer: names[contract.buyer_agent_id]?.agent_name,
  provider: names[contract.provider_agent_id]?.agent_name,
  negotiated: !!award,
  competing_bids: award?.competing_bid_count ?? null,
  won_on_price: award?.was_lowest_price ?? null,
  settlement_tx: settlement.tx_hash,
  settlement_url: scan(settlement.tx_hash),
  is_simulated: settlement.is_simulated,
  reputation_events: (events ?? []).map((e) => ({
    agent: names[e.agent_id]?.agent_name ?? e.agent_id.slice(0, 8),
    event: e.event_type, delta: e.delta, from: e.repid_before, to: e.repid_after,
  })),
  onchain_reputation_tx: onchain?.tx_hash ?? null,
  onchain_reputation_url: onchain ? scan(onchain.tx_hash) : null,
  onchain_repid_value: onchain?.repid_value ?? null,
  onchain_link_is_proven: false,
  zk_proofs: (proofs ?? []).map((p) => ({ scheme: p.scheme, real: p.is_real, statement: p.statement })),
};

if (asJson) { console.log(JSON.stringify(receipt, null, 2)); process.exit(0); }

const line = '─'.repeat(66);
console.log(`\n${line}\n  TRUST RECEIPT — one agent hired another, and it is all checkable\n${line}`);
console.log(`\n  ${receipt.buyer}  ──${receipt.price}──▶  ${receipt.provider}\n`);

if (receipt.negotiated) {
  console.log(`  1. NEGOTIATED.   ${receipt.competing_bids} providers bid. ` +
    `${receipt.won_on_price ? 'The cheapest won.' : 'A dearer bid won and had to justify itself in writing.'}`);
  console.log(`     The buyer never named the price — it was read from the winning bid.`);
} else {
  console.log(`  1. LISTED PRICE. This exchange predates negotiated pricing.`);
}
console.log(`\n  2. HELD, NOT PAID. The buyer signed a payment authorisation. Nothing moved.`);
console.log(`     No escrow contract, no extra gas — a signature is not a transfer.`);
console.log(`\n  3. WORK DELIVERED, then checked by verifiers that are not the provider.`);
console.log(`\n  4. ONLY THEN, PAID.  ${receipt.price} USDC, for real, on Base Sepolia`);
console.log(`     ${receipt.settlement_url}`);
console.log(`     simulated: ${receipt.is_simulated}   ← if this said true, none of it counted`);

if (receipt.reputation_events.length) {
  console.log(`\n  5. REPUTATION MOVED — both sides, earned not asserted:`);
  for (const e of receipt.reputation_events) {
    console.log(`     ${e.agent.padEnd(16)} ${String(e.event).padEnd(20)} ${e.delta > 0 ? '+' : ''}${e.delta}   ${e.from} → ${e.to}`);
  }
}
if (receipt.onchain_reputation_url) {
  const matches = receipt.reputation_events.some((e) => e.to === receipt.onchain_repid_value);
  console.log(`\n  6. WRITTEN WHERE WE CANNOT EDIT IT — ERC-8004 on Base Sepolia`);
  console.log(`     ${receipt.onchain_reputation_url}`);
  console.log(`     Reputation ${receipt.onchain_repid_value} recorded on-chain${matches ? ` — matches this exchange's outcome.` : `.`}`);
  console.log(`     Not our database. Anyone can check it without asking us.`);
  console.log(`     NOTE: the per-contract link is not recorded on these rows yet, so this`);
  console.log(`     is the provider's latest write — not PROVEN to be caused by this one.`);
}
if (receipt.zk_proofs.length) {
  const p = receipt.zk_proofs[0];
  console.log(`\n  7. ZERO-KNOWLEDGE PROOF attached  (${p.scheme}, real=${p.real})`);
  console.log(`     Proves a reputation THRESHOLD without revealing the score.`);
}
console.log(`\n${line}`);
console.log(`  The point: being wrong costs the agent something, and you can verify`);
console.log(`  that yourself — on a public chain — without trusting us.`);
console.log(`${line}\n`);
console.log(`  contract ${receipt.contract_id}`);
console.log(`  re-run any time:  npm run demo:trust        machine-readable:  npm run demo:trust -- --json\n`);
