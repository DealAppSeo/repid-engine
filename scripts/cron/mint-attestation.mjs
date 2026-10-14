#!/usr/bin/env node
/**
 * mint-attestation.mjs — LIVING PROOF minter.
 *
 * One self-contained cycle that produces a FRESH, independently-verifiable on-chain
 * ERC-8004 reputation attestation on Base Sepolia, end to end and for real:
 *
 *   1. pick the stalest eligible providers (repid >= 1000, minted erc8004 token, has a wallet),
 *      enough per run to renew each within MINT_FRESHNESS_TARGET_DAYS (rotation.mjs); steps 2-5 run per provider
 *   2. mint EPHEMERAL buyer + provider agent keys (service-role) — revoked in finally
 *   3. buyer buys the provider's verification service: create -> escrow (real x402 USDC)
 *      -> deliver (registered handler / cascade) -> satisfy -> settled
 *   4. the FeedbackLoopWorker writes the provider's RepID on-chain (ERC-8004)
 *   5. VERIFY that tx on Base Sepolia (eth_getTransactionReceipt: status 0x1 + to the
 *      ReputationRegistry) — never trust the DB's word
 *   6. print the BaseScan link; exit 0 iff a fresh write was verified
 *
 * NOTHING IS FAKED. If any leg can't run (unfunded wallet, no eligible provider, the
 * on-chain write never lands), it exits non-zero with the reason — it never prints a
 * fake UID. The proof surface is `erc8004_reputation_writes` (+ the chain itself), which
 * the site/demo already reads; this just keeps it fresh.
 *
 * ENV (all present on the repid-engine Railway service):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)  — mint/revoke keys, pick provider
 *   BASE_SEPOLIA_PRIVATE_KEY   — funded Base-Sepolia buyer wallet (pays test-USDC)
 *   ENGINE_BASE_URL            — default https://repid-engine-production.up.railway.app
 *   BASE_SEPOLIA_RPC(_URL)     — default https://sepolia.base.org
 *   MINT_BUYER_AGENT           — buyer agent name (default trinity-nexus; must not be the provider)
 *   MINT_FRESHNESS_TARGET_DAYS — renew every provider at least this often (default 4)
 *   MINT_MAX_PROVIDERS_PER_RUN — cost ceiling: providers attested per run (default 4)
 *
 * Schedule (Railway cron, recommended — server-side, has all the env above):
 *   node scripts/cron/mint-attestation.mjs        # once per run; set a daily cron
 *
 * The server must have X402_REAL_RPC=true + X402_ENFORCEMENT_ENABLED=true for a real
 * settlement (already set). Cost: ~0.05-0.1 test-USDC per PROVIDER from the buyer wallet (3 per run
 * at 11 eligible providers and the 4-day default).
 */
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import {
  rateDeliverable,
  classifyContractStatus,
  classifySatisfyResponse,
  ACCEPTANCE_CRITERIA,
  CLAIM_TEXT,
} from './rate-deliverable.mjs';
import { pickStalest, providersPerRun } from './rotation.mjs';

const BASE = (process.env.ENGINE_BASE_URL || 'https://repid-engine-production.up.railway.app').replace(/\/+$/, '');
const RPC = process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const CHAIN = 84532;
const REG = '0x8004b663056a597dffe9eccc1965a193b7388713'; // ERC-8004 ReputationRegistry
const BUYER_NAME = process.env.MINT_BUYER_AGENT || 'trinity-nexus';
// Every eligible provider should get a fresh write at least this often. trustshell's acceptance gate
// fails a served proof older than 7 days; 4 leaves a missed run or two of slack.
const TARGET_DAYS = Number(process.env.MINT_FRESHNESS_TARGET_DAYS || 4);
// Cost ceiling per run (each provider is one real test-USDC escrow + one on-chain write).
const MAX_PER_RUN = Number(process.env.MINT_MAX_PROVIDERS_PER_RUN || 4);

const url = process.env.SUPABASE_URL;
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const walletKey = (process.env.BASE_SEPOLIA_PRIVATE_KEY || '').trim();
function die(msg) { console.error('[mint-attestation] FAIL: ' + msg); process.exit(1); }
if (!url || !svcKey) die('missing SUPABASE_URL / service key');
if (!walletKey) die('missing BASE_SEPOLIA_PRIVATE_KEY (funded buyer wallet)');

const supa = createClient(url, svcKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The 2026-08-26 Railway "Crashed" run left NO diagnostic at all: the log ends
// right after "escrowed ..." with no [mint-attestation] FAIL line and no stack
// trace, which is only possible if the process died OUTSIDE the try/catch in
// main() — an uncaught exception or unhandled rejection that never reaches
// main().catch() below. Without these handlers that class of failure is
// silent by construction; with them, whatever killed the run gets one line
// naming it before the process exits, on the same log stream Railway shows.
process.on('uncaughtException', (e) => {
  console.error('[mint-attestation] UNCAUGHT EXCEPTION: ' + (e?.stack || e?.message || e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[mint-attestation] UNHANDLED REJECTION: ' + (e?.stack || e?.message || e));
  process.exit(1);
});

async function api(method, path, key, body, extra) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(extra || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function mintKey(agentId, name) {
  const raw = 'ts_live_' + crypto.randomBytes(16).toString('hex');
  const { data, error } = await supa.from('agent_api_keys').insert({ agent_id: agentId, key_hash: sha(raw), key_prefix: 'ts_live_ephemeral', name, scopes: [] }).select('id').single();
  if (error) throw new Error('mintKey(' + name + '): ' + error.message);
  return { raw, id: data.id };
}
async function buildX402(to, value) {
  const w = new ethers.Wallet(walletKey);
  const from = await w.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const domain = { name: 'USDC', version: '2', chainId: CHAIN, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const message = { from, to, value, validAfter: 0, validBefore: now + 3600, nonce };
  const signature = await w.signTypedData(domain, types, message);
  return Buffer.from(JSON.stringify({ ...message, signature }), 'utf8').toString('base64');
}

async function main() {
  // 1. buyer + an eligible provider (least-recently-attested, to rotate across the roster).
  const { data: buyer } = await supa.from('repid_agents').select('id, agent_name').eq('agent_name', BUYER_NAME).single();
  if (!buyer) die('buyer agent ' + BUYER_NAME + ' not found');
  const { data: svcs, error: svcErr } = await supa
    .from('agent_services').select('id, base_price_usdc_raw, provider_agent_id')
    .eq('service_type', 'verification').eq('active', true);
  if (svcErr) die('service query: ' + svcErr.message);
  const provIds0 = [...new Set((svcs || []).map((s) => s.provider_agent_id).filter(Boolean))];
  if (!provIds0.length) die('no active verification services');
  const { data: provs } = await supa.from('repid_agents').select('id, agent_name, current_repid, erc8004_token_id, wallet_address').in('id', provIds0);
  const provById = new Map((provs || []).map((p) => [p.id, p]));
  const eligible = (svcs || [])
    .map((s) => ({ svc: s, prov: provById.get(s.provider_agent_id) }))
    .filter((x) => x.prov && x.prov.current_repid >= 1000 && x.prov.erc8004_token_id && x.prov.wallet_address && x.prov.id !== buyer.id);
  if (!eligible.length) die('no eligible verification provider (repid>=1000 + minted + wallet)');
  // rotate: the providers whose last on-chain write is oldest, as many per run as keep every one
  // renewed within TARGET_DAYS. One per run was an 11-day cycle against a 7-day freshness gate
  // (rotation.mjs has the measurement).
  const provIds = [...new Set(eligible.map((e) => e.prov.id))];
  const { data: lastWrites } = await supa.from('erc8004_reputation_writes').select('agent_id, created_at').in('agent_id', provIds).order('created_at', { ascending: false });
  const lastByAgent = new Map();
  for (const w of lastWrites || []) if (!lastByAgent.has(w.agent_id)) lastByAgent.set(w.agent_id, w.created_at);
  const picks = pickStalest(eligible, lastByAgent, providersPerRun(provIds.length, TARGET_DAYS, MAX_PER_RUN));
  console.log(`[mint-attestation] ${provIds.length} eligible providers, freshness target ${TARGET_DAYS}d -> attesting ${picks.length} this run`);

  // Sequential, and one provider failing does not skip the rest: each cycle revokes its own keys.
  let failed = 0;
  for (const { svc, prov } of picks) {
    try {
      await attestOne(buyer, svc, prov);
    } catch (e) {
      failed++;
      console.error(`[mint-attestation] FAIL provider=${prov.agent_name}: ${e?.message ?? e}`);
    }
  }
  if (failed) die(`${failed} of ${picks.length} providers did not produce a verified write`);
  process.exitCode = 0;
}

/** One full cycle for one provider: create -> escrow -> deliver -> satisfy -> settled -> verified write. */
async function attestOne(buyer, svc, prov) {
  console.log(`[mint-attestation] buyer=${buyer.agent_name} provider=${prov.agent_name} (repid ${prov.current_repid}, token ${prov.erc8004_token_id}) price=${Number(svc.base_price_usdc_raw) / 1e6} USDC`);

  const keys = [];
  try {
    const buyerKey = await mintKey(buyer.id, 'living-proof-buyer'); keys.push(buyerKey.id);
    const provKey = await mintKey(prov.id, 'living-proof-provider'); keys.push(provKey.id);

    // 2. create -> escrow (real x402) -> deliver -> satisfy
    //
    // THE PAYLOAD MUST PARSE AS A WORK STATEMENT, OR THIS RUN STRANDS REAL MONEY.
    // [BROKE 2026-09-04, fixed same day.] #607 made `work_statement_hash` REQUIRED
    // to move a contract to `fulfilled`, but left contract CREATION permissive:
    // `if (spec.ok) insertRow.work_statement = spec.canonical` — an unparseable
    // payload is accepted, gets no hash, and can then never be fulfilled.
    //
    // This script sent `criteria: ['factual accuracy']`, which fails the spec
    // ("acceptance_criteria must be a non-empty numbered list; each text must be
    // explicit (>= 24 chars, not a placeholder)"). So the 12:00Z run created a
    // contract, escrowed REAL testnet USDC through x402, and then died at fulfil
    // with WORK_STATEMENT_REQUIRED — money committed, delivery impossible. The
    // create call still returned 201. Nothing failed until 30 seconds later, by
    // which point the funds were already gone.
    //
    // A gate added at one end of a pipeline has to be checked against every
    // producer feeding the other end. Create being lenient while fulfil is strict
    // is a trap with money in it, and this script is the only unattended producer.
    //
    // The criteria below are what the verification handler is actually paid to
    // do; they are the text ratings get scored against, so they say something
    // checkable rather than restating the title.
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const claimText = CLAIM_TEXT;
    const create = await api('POST', '/api/v1/contracts', buyerKey.raw, {
      service_id: svc.id,
      buyer_agent_id: buyer.id,
      agreed_price_usdc_raw: Number(svc.base_price_usdc_raw),
      payload: {
        content: claimText,
        title: `living-proof-${Date.now()}`,
        service_type: 'verification',
        deliverable: `A cross-provider factual verification verdict on the claim: "${claimText}"`,
        acceptance_criteria: ACCEPTANCE_CRITERIA,
        deadline,
        agreed_price: { amount_usdc_raw: Number(svc.base_price_usdc_raw), currency: 'USDC' },
      },
    });
    if (create.status !== 201 || !create.json?.id) throw new Error('create -> ' + create.status + ' ' + JSON.stringify(create.json).slice(0, 160));
    const cid = create.json.id;

    // CHECK BEFORE THE MONEY MOVES, not after. The create call returns 201 even
    // when the spec did not parse, so 201 is not evidence the contract can ever
    // be fulfilled. Escrow is the irreversible step — verify the hash exists
    // FIRST and abort while aborting is still free. This is the guard whose
    // absence turned a payload-shape mistake into stranded testnet USDC.
    if (!create.json?.work_statement_hash) {
      throw new Error(
        `create returned 201 but no work_statement_hash for ${cid} — the payload did not parse ` +
        'as a work statement, so fulfil would fail with WORK_STATEMENT_REQUIRED. Aborting BEFORE ' +
        'escrow so no funds are committed to a contract that cannot be delivered.'
      );
    }
    const header = await buildX402(prov.wallet_address, String(svc.base_price_usdc_raw));
    const escrow = await api('POST', `/api/v1/contracts/${cid}/escrow`, buyerKey.raw, {}, { 'X-PAYMENT': header });
    if (escrow.status !== 200 || escrow.json?.status !== 'escrowed') throw new Error('escrow -> ' + escrow.status + ' ' + JSON.stringify(escrow.json).slice(0, 200));
    console.log(`[mint-attestation] escrowed ${cid} (real x402 USDC settled)`);
    // deliver via the registered handler (provider identity), then satisfy (poll for cascade delivery).
    const processResp = await api('POST', '/api/v1/agent/process-contracts', provKey.raw, { agent_name: prov.agent_name });
    console.log(`[mint-attestation] process-contracts -> ${processResp.status}`);
    // RATE THE DELIVERABLE, DO NOT ASSERT A SCORE.
    //
    // [BROKE 2026-09-05, found 2026-09-09.] This sent `{satisfaction_score: 1}`,
    // and once contracts became work-statement-bound that stopped being accepted
    // at all: `deriveSatisfyScore` requires `criterion_ratings` whenever
    // `work_statement_hash` is set, and the legacy scalar branch is unreachable
    // for every contract this script now creates. So satisfy returned 400
    // RATING_REQUIRED on every attempt, all 8 polls failed, and five consecutive
    // daily runs left real USDC sitting authorized-but-uncaptured. The escrow fix
    // did not strand the money; it moved where the stranding happened.
    //
    // The replacement rates the criteria AGAINST THE DELIVERED RESULT rather than
    // hardcoding a verdict. `satisfaction_score: 1` was an assertion the buyer had
    // no basis for — the same "recorded as if it had been checked" shape this
    // codebase keeps removing, and it sat on the one path that moves real money.
    let settled = false;
    for (let i = 0; i < 8 && !settled; i++) {
      // Read what was actually delivered before rating it. A rating derived from
      // nothing is the defect being fixed, so a contract we cannot read is NOT
      // rated: we wait and retry rather than guessing a score in either
      // direction. Guessing high pays for unseen work; guessing low VOIDS a
      // legitimate payment. Neither is ours to invent.
      const got = await api('GET', `/api/v1/contracts/${cid}`, buyerKey.raw);
      if (got.status !== 200) {
        console.log(`[mint-attestation] satisfy attempt ${i + 1}/8 -> contract read ${got.status}; not rating`);
        await sleep(15000);
        continue;
      }
      const status = got.json?.status;
      const next = classifyContractStatus(status);
      if (next === 'settled') {
        // Satisfy moved the money and we misread its answer. Re-polling this to
        // the timeout below would report a FAILURE on a contract that SUCCEEDED.
        console.log(`[mint-attestation] satisfy attempt ${i + 1}/8 -> already settled`);
        settled = true;
        break;
      }
      if (next === 'terminal') {
        throw new Error(
          `contract is '${status}' and cannot reach fulfilled — this is not a delivery timeout`,
        );
      }
      if (next !== 'rate') {
        console.log(`[mint-attestation] satisfy attempt ${i + 1}/8 -> status '${status}', awaiting delivery`);
        await sleep(15000);
        continue;
      }

      const ratings = rateDeliverable(got.json.result);
      const met = ratings.filter((r) => r.met).length;
      console.log(
        `[mint-attestation] rated deliverable ${met}/${ratings.length}: ` +
        ratings.map((r) => `n${r.n}=${r.met ? 'met' : 'NOT met'}`).join(' '),
      );

      const s = await api('POST', `/api/v1/contracts/${cid}/satisfy`, buyerKey.raw, { criterion_ratings: ratings });
      console.log(`[mint-attestation] satisfy attempt ${i + 1}/8 -> ${s.status} ${s.json?.status ?? s.json?.error ?? ''}`);
      const answer = classifySatisfyResponse(s.status, s.json);
      if (answer === 'settled') { settled = true; break; }
      if (answer === 'voided') {
        throw new Error(
          `deliverable rated ${met}/${ratings.length}; payment authorization voided, no funds moved. ` +
          'This is the pay-on-verified-delivery path working, not a bug in it.',
        );
      }
      if (answer === 'reject') {
        throw new Error(
          `satisfy refused (${s.status} ${s.json?.error}): ${s.json?.message} — ` +
          'waiting cannot fix this; the ratings or the caller no longer match the contract.',
        );
      }
      await sleep(15000);
    }
    if (!settled) throw new Error('contract never reached settled (cascade delivery timeout)');
    console.log('[mint-attestation] settled; waiting for the on-chain write...');

    // 3. wait for the FeedbackLoopWorker's on-chain write, then VERIFY it on Base Sepolia.
    const sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let write = null;
    for (let i = 0; i < 12 && !write; i++) {
      await sleep(15000);
      const { data } = await supa.from('erc8004_reputation_writes').select('tx_hash, block_number, repid_value, created_at').eq('agent_id', prov.id).gt('created_at', sinceIso).order('created_at', { ascending: false }).limit(1);
      if (data && data[0]?.tx_hash) { write = data[0]; break; }
      console.log(`[mint-attestation] waiting for on-chain write ${i + 1}/12...`);
    }
    if (!write) throw new Error('no on-chain write appeared within ~3min (FeedbackLoopWorker may be off, or provider ineligible)');

    const provider = new ethers.JsonRpcProvider(RPC);
    const rcpt = await provider.getTransactionReceipt(write.tx_hash);
    const ok = rcpt && rcpt.status === 1 && String(rcpt.to).toLowerCase() === REG;
    if (!ok) throw new Error('on-chain verify failed for ' + write.tx_hash + ' (status ' + (rcpt?.status) + ', to ' + rcpt?.to + ')');
    console.log(`[mint-attestation] VERIFIED ✓ provider=${prov.agent_name} repid=${write.repid_value} block=${rcpt.blockNumber}`);
    console.log(`[mint-attestation] https://sepolia.basescan.org/tx/${write.tx_hash}`);
  } finally {
    if (keys.length) {
      const { error } = await supa.from('agent_api_keys').update({ revoked_at: new Date().toISOString() }).in('id', keys);
      console.log('[mint-attestation] ephemeral keys revoked' + (error ? ' (WARN: ' + error.message + ')' : ''));
    }
  }
}
main().catch((e) => { console.error('[mint-attestation] FAIL: ' + (e?.message ?? e)); process.exit(1); });
