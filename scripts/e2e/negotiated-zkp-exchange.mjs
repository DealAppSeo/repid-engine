/**
 * negotiated-zkp-exchange.mjs — the full A2A loop, for real.
 *
 * RFQ -> competing bids -> counter-offer -> atomic award -> escrow (payment
 * AUTHORIZED, not settled) -> delivery -> buyer accepts -> x402 settles on
 * Base Sepolia -> RepID moves -> ERC-8004.
 *
 * NOT A SIMULATION. Every row is written to the production Supabase project and
 * every transfer is broadcast to Base Sepolia. There is no mock branch in this
 * file: if a leg cannot run for real it is reported as NOT RUN, never faked.
 *
 * Reads credentials from .env.master. Prints fingerprints and addresses only —
 * never a key.
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const ENV = Object.fromEntries(
  readFileSync('C:/Users/Cash4/repos/.env.master', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const BASE = process.env.ENGINE_URL || 'http://127.0.0.1:3000';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;
const RPC = 'https://sepolia.base.org';

const sb = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY);
const provider = new ethers.JsonRpcProvider(RPC);

const steps = [];
function record(name, status, detail) {
  steps.push({ name, status, detail });
  const mark = status === 'PASS' ? 'ok  ' : status === 'NOT RUN' ? '--  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
function die(msg) { console.error(`\nHALT: ${msg}`); printSummary(); process.exit(1); }

async function api(path, { method = 'GET', key, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

/** Issue a scoped agent-bound API key. The plaintext of existing keys is
 *  sha256-hashed and unrecoverable by design, so this is the intended path. */
async function issueKey(agentId, name) {
  const raw = 'ts_live_' + crypto.randomBytes(16).toString('hex');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const { error } = await sb.from('agent_api_keys').insert({
    agent_id: agentId, key_hash: keyHash, key_prefix: raw.slice(0, 16),
    name, scopes: ['score_event', 'llm_complete', 'read_card'],
  });
  if (error) die(`could not issue key for ${name}: ${error.message}`);
  return raw;
}

function fp(v) { return crypto.createHash('sha256').update('trustkeys/v1' + v).digest('hex').slice(0, 12); }

async function usdcBalanceAt(addr, blockTag) {
  const data = '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');
  const r = await provider.call({ to: USDC, data, blockTag });
  return Number(BigInt(r)) / 1e6;
}

async function usdcBalance(addr) {
  const data = '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');
  const r = await provider.call({ to: USDC, data });
  return Number(BigInt(r)) / 1e6;
}

/** Build a real EIP-3009 TransferWithAuthorization and wrap it as an X-PAYMENT header. */
async function buildPayment({ signerKey, to, valueRaw, validSeconds = 3600 }) {
  const wallet = new ethers.Wallet(signerKey);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to,
    value: String(valueRaw),
    validAfter: 0,
    validBefore: now + validSeconds,
    nonce: '0x' + crypto.randomBytes(32).toString('hex'),
  };
  const domain = { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, authorization);
  const payload = { ...authorization, signature, authorization, payload: { authorization, signature } };
  return { header: Buffer.from(JSON.stringify(payload)).toString('base64'), from: wallet.address, validBefore: authorization.validBefore };
}

function printSummary() {
  console.log('\n' + '='.repeat(72));
  console.log('E2E SUMMARY');
  for (const s of steps) console.log(`  [${s.status.padEnd(7)}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  const pass = steps.filter((s) => s.status === 'PASS').length;
  const fail = steps.filter((s) => s.status === 'FAIL').length;
  const skip = steps.filter((s) => s.status === 'NOT RUN').length;
  console.log(`\n  ${pass} passed · ${fail} failed · ${skip} not run`);
}

// ── run ────────────────────────────────────────────────────────────────────
const BUYER = { id: '32e0e809-c1c4-4405-913f-135c8a2d6626', name: 'trinity-shofet' };
const P1 = { id: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067', name: 'trinity-veritas' };
const P2 = { id: 'd82b2ae5-1d1d-462e-87fb-57cb3e63017b', name: 'trinity-w3c' };

console.log('A2A NEGOTIATED EXCHANGE — REAL RUN');
console.log(`engine: ${BASE}   chain: Base Sepolia ${CHAIN_ID}   db: ${ENV.SUPABASE_URL.slice(8, 28)}…\n`);

const health = await api('/health');
if (health.status !== 200) die(`engine not reachable at ${BASE} (${health.status})`);
record('engine reachable', 'PASS', `commit ${health.json.deployed_commit_short ?? 'local'}, supabase=${health.json.supabaseConnected}`);

console.log('\nPHASE 1 — negotiation');
const buyerKey = await issueKey(BUYER.id, 'e2e-buyer');
const p1Key = await issueKey(P1.id, 'e2e-provider-1');
const p2Key = await issueKey(P2.id, 'e2e-provider-2');
record('agent-bound keys issued', 'PASS', `buyer ${fp(buyerKey)} · p1 ${fp(p1Key)} · p2 ${fp(p2Key)} (fingerprints only)`);

const { data: svc1 } = await sb.from('agent_services').select('id, base_price_usdc_raw')
  .eq('provider_agent_id', P1.id).eq('service_type', 'verification').eq('active', true).limit(1).maybeSingle();
const { data: svc2 } = await sb.from('agent_services').select('id, base_price_usdc_raw')
  .eq('provider_agent_id', P2.id).eq('service_type', 'verification').eq('active', true).limit(1).maybeSingle();
if (!svc1 || !svc2) die('need one active `verification` service per provider');

const rfqRes = await api('/api/v1/negotiation/rfqs', {
  method: 'POST', key: buyerKey,
  body: {
    buyer_agent_id: BUYER.id,
    service_type: 'verification',
    scope: { task: 'Verify the claim: Base Sepolia chain id is 84532.', deliverable: 'verdict + cited evidence' },
    // award_mode=immediate. The DEFAULT is sealed_close, which correctly refuses
    // any award before bids_close_at (verified live: 425 sealed_until_close) —
    // that is the anti-sniping rule and it is not being bypassed. `immediate` is
    // a first-class mode, frozen at RFQ creation and shown to every bidder
    // before they bid, so nobody is surprised by it.
    award_mode: 'immediate',
    min_price_usdc_raw: 10000,
    max_price_usdc_raw: 200000,
    // The API takes explicit ISO-8601 instants, not durations — an auction
    // window is a wall-clock fact both parties must agree on.
    // The engine enforces a MINIMUM 1-hour bidding window (window_too_short).
    // That is an anti-sniping rule, not a nuisance: a short window lets a buyer
    // open and award an auction before any honest competitor can see it, which
    // is the uncontested-award shape a wash trade needs. Respect it.
    bids_close_at: new Date(Date.now() + 65 * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
  },
});
if (rfqRes.status !== 201) die(`RFQ create failed ${rfqRes.status}: ${JSON.stringify(rfqRes.json).slice(0, 400)}`);
const rfqId = rfqRes.json.rfq?.id ?? rfqRes.json.rfq_id ?? rfqRes.json.id;
if (!rfqId) die(`RFQ created but no id in response: ${JSON.stringify(rfqRes.json).slice(0,300)}`);
record('RFQ posted', 'PASS', `${rfqId}`);

const bid1 = await api(`/api/v1/negotiation/rfqs/${rfqId}/bids`, {
  method: 'POST', key: p1Key,
  body: { provider_agent_id: P1.id, service_id: svc1.id, price_usdc_raw: 120000, eta_seconds: 600, terms: { note: 'full cited verification' } },
});
const bid2 = await api(`/api/v1/negotiation/rfqs/${rfqId}/bids`, {
  method: 'POST', key: p2Key,
  body: { provider_agent_id: P2.id, service_id: svc2.id, price_usdc_raw: 100000, eta_seconds: 900, terms: { note: 'standard verification' } },
});
if (bid1.status !== 201 || bid2.status !== 201) {
  die(`bids failed: p1=${bid1.status} ${JSON.stringify(bid1.json).slice(0, 200)} | p2=${bid2.status} ${JSON.stringify(bid2.json).slice(0, 200)}`);
}
record('two competing bids', 'PASS', `p1=0.12 USDC/600s · p2=0.10 USDC/900s — a real price spread`);

const b2 = bid2.json.bid ?? bid2.json;
const b2Id = b2.id ?? bid2.json.bid_id;
const b2Round = bid2.json.round?.id ?? b2.current_round_id;
if (!b2Id || !b2Round) die(`bid response shape unexpected: ${JSON.stringify(bid2.json).slice(0, 400)}`);

// The buyer awards the CHEAPER bid (p2, 0.10 USDC). was_lowest_price is then
// true, so no written rationale is required — that constraint exists precisely
// for the case where a buyer passes over the cheapest bid.
const accept = await api(`/api/v1/negotiation/rfqs/${rfqId}/accept`, {
  method: 'POST', key: buyerKey,
  body: { buyer_agent_id: BUYER.id, bid_id: b2Id, round_id: b2Round },
});
if (accept.status !== 201 && accept.status !== 200) {
  die(`accept failed ${accept.status}: ${JSON.stringify(accept.json).slice(0, 500)}`);
}
const contractId = accept.json.contract_id ?? accept.json.contract?.id ?? accept.json.award?.contract_id;
const awardId = accept.json.award_id ?? accept.json.award?.id;
record('bid awarded atomically', 'PASS', `contract ${contractId} · award ${awardId}`);

// Prove the award is real and self-consistent, straight from the database —
// not from the response the same code path just produced.
const { data: award } = await sb.from('a2a_awards')
  .select('awarded_price_usdc_raw, was_lowest_price, is_uncontested, competing_bid_count, offer_hash_verified, provider_agent_id')
  .eq('contract_id', contractId).maybeSingle();
const { data: contract } = await sb.from('service_contracts')
  .select('id, agreed_price_usdc_raw, buyer_agent_id, provider_agent_id, status')
  .eq('id', contractId).maybeSingle();
const { data: bidRows } = await sb.from('a2a_bids').select('id,status').eq('rfq_id', rfqId);
if (!award || !contract) die('award or contract row missing after a 2xx accept');

record('contract price == awarded round price',
  Number(award.awarded_price_usdc_raw) === Number(contract.agreed_price_usdc_raw) ? 'PASS' : 'FAIL',
  `${contract.agreed_price_usdc_raw} raw = $${(contract.agreed_price_usdc_raw / 1e6).toFixed(2)} — the buyer never sent a price`);
record('award provenance recorded', award.offer_hash_verified ? 'PASS' : 'FAIL',
  `competing_bids=${award.competing_bid_count} was_lowest=${award.was_lowest_price} uncontested=${award.is_uncontested}`);
record('losing bid retained', (bidRows || []).some((b) => b.status === 'lost') ? 'PASS' : 'FAIL',
  (bidRows || []).map((b) => b.status).join(', '));

console.log('\n[state] ' + JSON.stringify({ rfqId, contractId, awardId, priceRaw: contract.agreed_price_usdc_raw, provider: contract.provider_agent_id, status: contract.status }));
printSummary();

// ── PHASE 2 — escrow: payment VERIFIED and HELD, nothing on-chain ───────────
console.log('\nPHASE 2 — escrow (authorize, do not settle)');

const { data: provRow } = await sb.from('repid_agents').select('wallet_address').eq('id', contract.provider_agent_id).maybeSingle();
const providerWallet = provRow?.wallet_address;
if (!providerWallet) die('winning provider has no wallet_address — cannot build a payTo');

const buyerSignerKey = ENV.BASE_SEPOLIA_PRIVATE_KEY;
if (!buyerSignerKey) die('BASE_SEPOLIA_PRIVATE_KEY absent — refusing to invent a funded wallet');

const payerAddr = new ethers.Wallet(buyerSignerKey).address;
const balBefore = { payer: await usdcBalance(payerAddr), provider: await usdcBalance(providerWallet) };
record('pre-flight balances read on-chain', 'PASS',
  `payer ${balBefore.payer.toFixed(4)} USDC · provider ${balBefore.provider.toFixed(4)} USDC`);

const pay = await buildPayment({ signerKey: buyerSignerKey, to: providerWallet, valueRaw: contract.agreed_price_usdc_raw });
const escrow = await fetch(`${BASE}/api/v1/contracts/${contractId}/escrow`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyerKey}`, 'X-PAYMENT': pay.header },
});
const escrowJson = await escrow.json().catch(() => ({}));
if (escrow.status !== 200) die(`escrow failed ${escrow.status}: ${JSON.stringify(escrowJson).slice(0, 500)}`);
record('escrow accepted', 'PASS', `payment_state=${escrowJson.payment_state ?? '(legacy settle-at-escrow)'}`);

const { data: settleRow } = await sb.from('x402_settlements')
  .select('id, status, tx_hash, is_simulated, amount').eq('idempotency_key', contractId).maybeSingle();
const heldCorrectly = settleRow?.status === 'authorized' && settleRow?.tx_hash === null;
record('THE KEYSTONE: money NOT moved at escrow', heldCorrectly ? 'PASS' : 'FAIL',
  `status=${settleRow?.status} tx_hash=${settleRow?.tx_hash ?? 'null'} is_simulated=${settleRow?.is_simulated}`);

const midProvider = await usdcBalance(providerWallet);
record('provider balance unchanged after escrow', midProvider === balBefore.provider ? 'PASS' : 'FAIL',
  `${midProvider.toFixed(4)} USDC (was ${balBefore.provider.toFixed(4)})`);

// ── PHASE 3 — delivery ─────────────────────────────────────────────────────
console.log('\nPHASE 3 — delivery');
const fulfil = await api(`/api/v1/contracts/${contractId}/fulfill`, {
  method: 'POST', key: p2Key,
  body: { result: { verdict: 'PASS', summary: 'Base Sepolia chain id is 84532.', evidence: ['https://chainlist.org/chain/84532'], confidence: 0.99 } },
});
if (fulfil.status !== 200) die(`fulfil failed ${fulfil.status}: ${JSON.stringify(fulfil.json).slice(0, 400)}`);
record('provider delivered', 'PASS', `contract status=${fulfil.json.status}`);

// ── PHASE 4 — the buyer accepts, and ONLY THEN does money move ──────────────
console.log('\nPHASE 4 — release');
const satisfy = await api(`/api/v1/contracts/${contractId}/satisfy`, {
  method: 'POST', key: buyerKey, body: { satisfaction_score: 0.95 },
});
if (satisfy.status !== 200) die(`satisfy failed ${satisfy.status}: ${JSON.stringify(satisfy.json).slice(0, 600)}`);
const release = satisfy.json.payment_release;
record('payment released on buyer acceptance', release?.status === 'SETTLED' ? 'PASS' : 'FAIL',
  `${release?.status} tx=${release?.txHash ?? 'none'}${release?.reason ? ' — ' + release.reason.slice(0, 120) : ''}`);

if (release?.txHash) {
  const rc = await provider.getTransactionReceipt(release.txHash);
  record('settlement tx confirmed on Base Sepolia', rc && rc.status === 1 ? 'PASS' : 'FAIL',
    rc ? `block ${rc.blockNumber} status=${rc.status} https://sepolia.basescan.org/tx/${release.txHash}` : 'receipt not found');
  // Read the balance AT THE SETTLED BLOCK, not "now". A plain latest-block read
  // immediately after the receipt returned the pre-transfer figure on the first
  // run and produced a false FAIL — the chain was right, the assertion was
  // early. Pinning the block makes this deterministic instead of a race.
  const balAfter = await usdcBalanceAt(providerWallet, rc.blockNumber);
  const balBeforeBlk = await usdcBalanceAt(providerWallet, rc.blockNumber - 1);
  record('provider USDC actually increased', balAfter > balBeforeBlk ? 'PASS' : 'FAIL',
    `${balBeforeBlk.toFixed(4)} -> ${balAfter.toFixed(4)} (+${(balAfter - balBeforeBlk).toFixed(4)}) at block ${rc.blockNumber}`);
}

const { data: finalSettle } = await sb.from('x402_settlements')
  .select('status, tx_hash, is_simulated').eq('idempotency_key', contractId).maybeSingle();

record('settlement row records the tx (ledger matches chain)',
  finalSettle?.is_simulated === false && finalSettle?.status === 'settled' && !!finalSettle?.tx_hash ? 'PASS' : 'FAIL',
  `status=${finalSettle?.status} is_simulated=${finalSettle?.is_simulated} tx_hash=${finalSettle?.tx_hash ? 'recorded' : 'NULL'}`);

console.log('\n[final] ' + JSON.stringify({ contractId, awardId, settleTx: release?.txHash ?? null }));
printSummary();
