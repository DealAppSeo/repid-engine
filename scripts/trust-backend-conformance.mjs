#!/usr/bin/env node
//
// trust-backend-conformance.mjs — can a new front end rely on the trust backend today?
//
// One keyless run that follows ONE agent through the public API and checks that the answers agree with each
// other: health -> RepID -> passport -> zk proof -> proof verify (real, then altered) -> ERC-8004 -> on-chain
// reputation -> public receipt. Optional legs: a chain readback (RPC_URL) and a HAL fact-check (--hal).
//
// Usage:
//   node scripts/trust-backend-conformance.mjs                         # live, default agent
//   node scripts/trust-backend-conformance.mjs --agent trinity-nexus
//   node scripts/trust-backend-conformance.mjs --save out/             # live, and keep every response
//   node scripts/trust-backend-conformance.mjs --offline out/        # rerun against answers kept with --save
//   node scripts/trust-backend-conformance.mjs --hal                   # also spend 2 of the per-IP HAL budget
//   RPC_URL=https://sepolia.base.org node scripts/trust-backend-conformance.mjs   # enables the chain readback
//   --json                                                             # machine-readable legs on stdout
//   --plant wrong-agent | altered-accepted | simulated-receipt         # see it fail: changes ONE answer in memory
//
// STANDALONE, like verify-trust-receipt.mjs beside it: no imports from this repo. Its one optional dependency is the
// published proof verifier, for the leg that checks the proof on this machine. Otherwise it is
// what an outside front end would have to write, not the server agreeing with itself.
//
// THREE OUTCOMES PER LEG: VERIFIED / NOT_CHECKED / FAILED. A leg that could not run (endpoint unreachable, no
// RPC configured, HAL not requested) is NOT_CHECKED with the reason. It is never a pass.
// Exit 0: nothing FAILED and at least one leg VERIFIED. Exit 1: something FAILED. Exit 2: nothing could be checked.
//
// WHAT A GREEN RUN DOES NOT SHOW: that the proof is zero-knowledge (the score is a public input), that the proof
// could only have been made for this agent (measured 2026-11-19 with the standalone verifier: about 1 in 230
// random other agent ids verify the same bytes, and so does shifting score and threshold together), that the
// proof was checked by anything other than this API (use the published verifier for that), or that scores are
// fresh. It shows the public surface is up, answers in the documented shapes, and is internally consistent.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const BASE = (process.env.CONFORMANCE_BASE ?? 'https://repid-engine-production.up.railway.app').replace(/\/+$/, '');
const AGENT = flag('--agent') ?? 'trinity-nexus';
const OFFLINE = flag('--offline'), SAVE = flag('--save'), WANT_HAL = argv.includes('--hal'), JSON_OUT = argv.includes('--json');

// --plant: a rehearsal of a broken backend. One answer is changed after it is fetched, the run is labelled, and the
// exit code is never 0. It exists so a newcomer can watch the check refuse something.
const PLANT = flag('--plant');
const PLANTS = {
  'wrong-agent': ['proof', (j) => { j.statement.agent_id = '00000000-0000-4000-8000-0000000000bb'; }, 'the proof is served for a different agent'],
  'altered-accepted': ['verify_altered', (j) => { j.verified = true; delete j.error; }, 'the verify route accepts an altered statement'],
  'simulated-receipt': ['receipt', (j) => { j.is_simulated = true; }, 'the receipt is marked simulated'],
};
if (PLANT && !PLANTS[PLANT]) { console.error(`unknown --plant ${PLANT}; choose one of: ${Object.keys(PLANTS).join(', ')}`); process.exit(2); }
const legs = [];
const leg = (name, outcome, detail) => legs.push({ name, outcome, detail });
const TIERS = ['PROBATIONARY', 'EARNING', 'ESTABLISHED', 'AUTONOMOUS', 'VETERAN'];
const ladder = (s) => (s >= 8000 ? 4 : s >= 5000 ? 3 : s >= 1000 ? 2 : s >= 500 ? 1 : 0);
// The registry a passport may name. A backend that names its own registry and a matching owner would otherwise
// pass the chain readback against the wrong contract (review finding, 2026-11-19). Override for another network.
const REGISTRY = (process.env.CONFORMANCE_REGISTRY ?? '0x8004A818BFB912233c491871b3d84c89A494BD9e').toLowerCase(); // ERC-8004 IdentityRegistry, Base Sepolia (84532)
const CHAIN_ID = Number(process.env.CONFORMANCE_CHAIN_ID ?? 84532); // Base Sepolia
const isHex = (v, n) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);

/** One named response: from the fixture folder when offline, from the API otherwise. null = could not be read. */
async function get(key, path, body) {
  if (OFFLINE) {
    const f = join(OFFLINE, `${key}.json`);
    if (!existsSync(f)) return { status: 0, json: null, _why: `no fixture ${key}.json` };
    const saved = JSON.parse(readFileSync(f, 'utf8'));
    if (PLANT && PLANTS[PLANT][0] === key && saved.json) PLANTS[PLANT][1](saved.json);
    return { ...saved, _why: null };
  }
  const t0 = Date.now();
  let out;
  try {
    const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    let json = null; try { json = await r.json(); } catch { /* not JSON: json stays null */ }
    out = { status: r.status, ms: Date.now() - t0, json };
  } catch (e) { out = { status: 0, ms: Date.now() - t0, json: null, error: String(e?.message ?? e).slice(0, 120) }; }
  if (SAVE) { mkdirSync(SAVE, { recursive: true }); writeFileSync(join(SAVE, `${key}.json`), JSON.stringify(out, null, 1)); }
  if (PLANT && PLANTS[PLANT][0] === key && out.json) PLANTS[PLANT][1](out.json);
  return { ...out, _why: out.status === 0 ? `unreachable (${out.error})` : null };
}
/** Run one leg. `check` returns null when it holds, or a sentence saying what is wrong. */
function judge(name, res, check, okDetail) {
  if (!res || res.status === 0) return leg(name, 'NOT_CHECKED', res?._why ?? 'no response');
  if (res.status !== 200 || !res.json) return leg(name, 'FAILED', `HTTP ${res.status}${res.json?.error ? `: ${res.json.error}` : ''}`);
  let bad; try { bad = check(res.json); } catch (e) { bad = `response not in the expected shape (${e.message})`; }
  return leg(name, bad ? 'FAILED' : 'VERIFIED', bad ?? okDetail(res.json));
}

// 1. health
const health = await get('health', '/health');
judge('health', health, (j) => (j.status !== 'ok' ? `status is ${j.status}` : !j.deployed_commit ? 'no deployed_commit' : j.supabaseConnected === false ? 'database not connected' : null),
  (j) => `ok, commit ${String(j.deployed_commit).slice(0, 8)}`);

// 2. RepID
const repid = await get('repid', `/api/v1/repid/${encodeURIComponent(AGENT)}`);
const score = repid.json?.score, tier = repid.json?.tier;
judge('repid', repid, (j) => (!Number.isFinite(j.score) || j.score < 10 || j.score > 10000 ? `score ${j.score} is outside 10..10000`
  : !TIERS.includes(j.tier) ? `unknown tier ${j.tier}`
  : TIERS.indexOf(j.tier) > ladder(j.score) ? `tier ${j.tier} is above what score ${j.score} allows` : null),
  (j) => `score ${j.score}, tier ${j.tier}${TIERS.indexOf(j.tier) < ladder(j.score) ? ' (held below the score band, which the counterparty rule allows)' : ''}`);

// 3. passport agrees with RepID
const passport = await get('passport', `/api/v1/passport/${encodeURIComponent(AGENT)}`);
const uuid = passport.json?.agent?.agent_id ?? null;
judge('passport', passport, (j) => (!j.agent?.agent_id ? 'no agent id'
  : Number.isFinite(score) && j.reputation?.repid_score !== score ? `passport score ${j.reputation?.repid_score} differs from /repid score ${score}`
  : tier && j.reputation?.tier !== tier ? `passport tier ${j.reputation?.tier} differs from /repid tier ${tier}`
  : j.onchain?.registry && String(j.onchain.registry).toLowerCase() !== REGISTRY ? `passport names registry ${j.onchain.registry}, not the known one ${REGISTRY}` : null),
  (j) => `agent ${j.agent.agent_id}, score and tier agree with /repid${j.onchain?.registry ? ', registry is the known one' : ''}`);

// 4. zk proof: what it states
const proof = uuid ? await get('proof', `/api/v1/repid/${uuid}/proof`) : { status: 0, _why: 'no agent id from the passport' };
const st = proof.json?.statement;
judge('zk proof read', proof, (j) => (typeof j.proof_bytes !== 'string' || j.proof_bytes.length < 64 ? 'no proof bytes'
  : !j.statement ? 'no statement'
  : j.statement.agent_id !== uuid ? `the proof is for agent ${j.statement.agent_id}, not ${uuid}`
  : !(j.statement.repid_score >= j.statement.threshold) ? `statement says score ${j.statement.repid_score} >= ${j.statement.threshold}, which is false`
  : Number.isFinite(score) && score < j.statement.threshold ? `the proof says score >= ${j.statement.threshold}, but the current score is ${score}: the claim no longer holds`
  : null),
  (j) => `${j.scheme}: the statement says score ${j.statement.repid_score} >= ${j.statement.threshold}${Number.isFinite(score) && score !== j.statement.repid_score ? ` (proved at ${j.statement.repid_score}; the score is ${score} now, still above the threshold)` : ''} and names this agent; ${j.proof_bytes.length} chars`);

// 5. the API's own verifier accepts the real proof and refuses an altered statement
if (proof.status === 200 && st && proof.json.proof_bytes) {
  const real = await get('verify_real', '/api/v1/proof/verify', { proof_bytes: proof.json.proof_bytes, statement: st });
  judge('zk verify (this API, real proof)', real, (j) => (j.verified === true ? null : `the API did not verify its own proof: ${j.error ?? JSON.stringify(j).slice(0, 120)}`),
    (j) => `verified by ${j.scheme ?? 'the API verifier'} (server-side check, not an independent one)`);
  const altered = await get('verify_altered', '/api/v1/proof/verify', { proof_bytes: proof.json.proof_bytes, statement: { ...st, repid_score: st.repid_score + 1 } });
  judge('zk verify (this API, altered statement)', altered, (j) => (j.verified === false ? null : 'an altered statement was ACCEPTED'),
    (j) => `refused, as it must be${j.error ? ` (${String(j.error).slice(0, 80)})` : ''}`);
} else { leg('zk verify (this API, real proof)', 'NOT_CHECKED', 'no proof to send'); leg('zk verify (this API, altered statement)', 'NOT_CHECKED', 'no proof to send'); }

// 5b. the published verifier, run HERE: no call to this API or to the prover. Optional: needs the package.
{
  let wasm = null, whyNot = null;
  try { wasm = createRequire(import.meta.url)('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js'); wasm.init_panic_hook(); }
  catch (e) { whyNot = 'the published verifier (@hyperdag/proof-verifier) is not installed here'; }
  const local = (statement) => JSON.parse(wasm.verify_proof(JSON.stringify({ proof_bytes: proof.json.proof_bytes, statement })));
  if (!wasm || proof.status !== 200 || !st || !proof.json?.proof_bytes) {
    leg('zk verify (published verifier, run locally)', 'NOT_CHECKED', whyNot ?? 'no proof to check');
  } else {
    try {
      const real = local(st), altered = local({ ...st, repid_score: st.repid_score + 1 });
      const bad = real.verified !== true ? `the published verifier rejects the served proof: ${real.error}` : altered.verified !== false ? 'the published verifier ACCEPTED an altered statement' : null;
      leg('zk verify (published verifier, run locally)', bad ? 'FAILED' : 'VERIFIED', bad ?? `verifier ${real.verifier_version}: the served proof verifies and a statement with the score changed by one is refused, with no call to the API`);
    } catch (e) { leg('zk verify (published verifier, run locally)', 'FAILED', `the verifier threw: ${String(e.message).slice(0, 100)}`); }
  }
}

// 5c. Two things a valid proof is often taken to mean, and this format does not establish. They are separate
// lines so a green validity leg above is never read as either of them.
if (proof.status === 200 && st) {
  leg('zk agent binding', 'NOT_CHECKED', 'Agent binding not verified: this proof format ties the proof to its agent id only weakly (measured 2026-11-19 with the published verifier: about 1 in 230 random other agent ids verify the same bytes). The statement names the agent; the proof does not establish it.');
  leg('zk private disclosure', 'NOT_CHECKED', 'Not offered by this proof format: the score and the threshold are public inputs. This is a validity proof of "score above threshold", not a zero-knowledge proof.');
} else { leg('zk agent binding', 'NOT_CHECKED', 'no proof to assess'); leg('zk private disclosure', 'NOT_CHECKED', 'no proof to assess'); }

// 6. ERC-8004 view agrees
const erc = await get('erc8004', `/api/v1/erc8004/validate/${encodeURIComponent(AGENT)}`);
judge('erc8004 validate', erc, (j) => (uuid && j.agent_id !== uuid ? `agent id ${j.agent_id} differs from the passport's`
  : Number.isFinite(score) && j.reputation_score !== score ? `score ${j.reputation_score} differs from /repid score ${score}`
  : tier && j.tier !== tier ? `tier ${j.tier} differs from /repid tier ${tier}` : null),
  (j) => `validation_status ${j.validation_status}; id, score and tier agree`);

// 7. on-chain reputation record agrees with the passport
const rep = uuid ? await get('reputation_onchain', `/api/v1/agents/${uuid}/reputation/onchain`) : { status: 0, _why: 'no agent id from the passport' };
const tokenId = passport.json?.identity_erc8004?.token_id ?? null;
judge('reputation on chain (as the API reports it)', rep, (j) => (tokenId && String(j.token_id) !== String(tokenId) ? `token ${j.token_id} differs from the passport's ${tokenId}`
  : !Number.isFinite(Number(j.feedback_count)) ? 'no feedback count' : !isHex(j.contract, 40) ? 'no contract address' : null),
  (j) => `token ${j.token_id}, ${j.feedback_count} feedback entries at ${j.contract}`);

const rpc = async (method, params) => {
  const r = await fetch(process.env.RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  return r.json();
};
let wrongChain = null; // a sentence when the RPC serves another chain; reads from it prove nothing about this one
if (!OFFLINE && process.env.RPC_URL) {
  try { const c = await rpc('eth_chainId', []); const id = parseInt(c.result, 16); if (id !== CHAIN_ID) wrongChain = `the RPC serves chain ${Number.isFinite(id) ? id : 'unknown'}, not ${CHAIN_ID}`; }
  catch (e) { wrongChain = `the RPC did not say which chain it serves (${String(e.message).slice(0, 60)})`; }
}

// 8. chain readback: does the registry itself name the owner the passport names?
const RPC = process.env.RPC_URL;
const reg = passport.json?.onchain?.registry, owner = passport.json?.onchain?.owner;
if (OFFLINE) leg('chain readback', 'NOT_CHECKED', 'offline run');
else if (!RPC) leg('chain readback', 'NOT_CHECKED', 'set RPC_URL (for example https://sepolia.base.org) to read the registry directly');
else if (wrongChain) leg('chain readback', 'NOT_CHECKED', wrongChain);
else if (!isHex(reg, 40) || !isHex(owner, 40) || !tokenId) leg('chain readback', 'NOT_CHECKED', 'the passport names no registry, owner or token to compare');
else if (reg.toLowerCase() !== REGISTRY) leg('chain readback', 'FAILED', `the passport names registry ${reg}, not the known one ${REGISTRY}`);
else {
  try {
    const data = '0x6352211e' + BigInt(tokenId).toString(16).padStart(64, '0'); // ownerOf(uint256)
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: reg, data }, 'latest'] }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    const onchain = typeof j.result === 'string' && j.result.length >= 66 ? '0x' + j.result.slice(-40) : null;
    if (!onchain) leg('chain readback', 'NOT_CHECKED', `the RPC gave no owner (${j.error?.message ?? 'empty result'})`);
    else leg('chain readback', onchain.toLowerCase() === owner.toLowerCase() ? 'VERIFIED' : 'FAILED', onchain.toLowerCase() === owner.toLowerCase() ? `registry ${reg} says token ${tokenId} is owned by ${onchain}, as the passport says` : `registry says ${onchain}, passport says ${owner}`);
  } catch (e) { leg('chain readback', 'NOT_CHECKED', `RPC unreachable (${String(e.message).slice(0, 80)})`); }
}

// 9. public receipt: shape only here; verify-trust-receipt.mjs checks its hashes and chain leg
const receipt = await get('receipt', '/api/v1/receipt/latest.json');
judge('public receipt', receipt, (j) => (!j.contract_id ? 'no contract id' : !isHex(j.settlement_tx, 64) ? 'no settlement transaction'
  : typeof j.is_simulated !== 'boolean' ? 'does not say whether it was simulated'
  : j.is_simulated ? 'the settlement is marked simulated, so this is not a real exchange'
  : !Array.isArray(j.zk_proofs) || !Array.isArray(j.reputation_events) ? 'no proof or reputation list'
  : j.zk_proofs.length === 0 ? 'lists no proofs, so nothing about them was checked'
  : j.zk_proofs.some((p) => p.is_real !== true) ? 'lists a proof that is not marked real' : null),
  (j) => `contract ${j.contract_id}: real settlement, ${j.zk_proofs.length} proofs, ${j.reputation_events.length} reputation events (run verify-trust-receipt.mjs for the hashes)`);

// 9b. the receipt's settlement transaction is on chain and succeeded (needs RPC_URL)
if (OFFLINE) leg('settlement on chain', 'NOT_CHECKED', 'offline run');
else if (!RPC) leg('settlement on chain', 'NOT_CHECKED', 'set RPC_URL to look the settlement transaction up');
else if (wrongChain) leg('settlement on chain', 'NOT_CHECKED', wrongChain);
else if (!isHex(receipt.json?.settlement_tx, 64)) leg('settlement on chain', 'NOT_CHECKED', 'the receipt names no settlement transaction');
else {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [receipt.json.settlement_tx] }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    if (j.error) leg('settlement on chain', 'NOT_CHECKED', `the RPC answered an error (${j.error.message})`);
    else if (!j.result) leg('settlement on chain', 'FAILED', `no transaction ${receipt.json.settlement_tx} on the chain this RPC serves`);
    else if (j.result.status !== '0x1') leg('settlement on chain', 'FAILED', `transaction found but its status is ${j.result.status}`);
    else {
      // ERC-20 Transfer(from, to, value): topic 2 is the recipient. An unrelated successful transaction would not pay the payee.
      const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const payee = isHex(receipt.json.payee_wallet, 40) ? receipt.json.payee_wallet.toLowerCase().slice(2) : ''; // a full address or nothing: a short suffix must not match
      const paid = (j.result.logs ?? []).filter((l) => l.topics?.[0] === TRANSFER && payee && String(l.topics[2] ?? '').toLowerCase() === '0x' + payee.padStart(64, '0'));
      const amount = paid.length ? BigInt(paid[0].data) : null;
      if (!payee) leg('settlement on chain', 'NOT_CHECKED', 'the transaction succeeded, but the receipt names no payee wallet to match it to');
      else if (!paid.length) leg('settlement on chain', 'FAILED', `the transaction succeeded but moved no tokens to the payee ${receipt.json.payee_wallet}`);
      else if (Number.isFinite(receipt.json.price_raw) && amount !== BigInt(receipt.json.price_raw)) leg('settlement on chain', 'FAILED', `the transaction paid the payee ${amount}, but the receipt says ${receipt.json.price_raw}`);
      else if (!Number.isFinite(receipt.json.price_raw)) leg('settlement on chain', 'NOT_CHECKED', `the transaction paid the payee ${amount}, but the receipt states no price_raw to compare it with`);
      else leg('settlement on chain', 'VERIFIED', `block ${parseInt(j.result.blockNumber, 16)}: a successful token transfer of ${amount} to the payee the receipt names`);
    }
  } catch (e) { leg('settlement on chain', 'NOT_CHECKED', `RPC unreachable (${String(e.message).slice(0, 80)})`); }
}

// 10. HAL: one claim with a known answer, one that cannot be known. Opt-in: each call spends per-IP budget.
const HAL_CASES = [
  { key: 'hal_known', name: 'HAL (known false claim)', text: 'The Eiffel Tower is located in Berlin, Germany.', want: (d) => d !== 'clean', says: 'a plainly false claim must not come back clean' },
  { key: 'hal_abstain', name: 'HAL (unknowable claim)', text: 'On 3 March 2031 the fourth customer of a bakery in Tromso bought exactly two cinnamon buns.', want: (d) => d === 'abstain' || d === 'flagged', says: 'an unknowable claim must come back abstain or flagged: clean would assert it true, and vetoed would assert it false (and costs the producer RepID)' },
];
for (const c of HAL_CASES) {
  if (!OFFLINE && !WANT_HAL) { leg(c.name, 'NOT_CHECKED', 'not requested (--hal)'); continue; }
  const r = await get(c.key, '/api/v1/hal/evaluate', { text: c.text, source: 'conformance' });
  if (r.status === 429) { leg(c.name, 'NOT_CHECKED', 'the per-IP HAL budget is spent (HTTP 429)'); continue; }
  judge(c.name, r, (j) => { const d = String(j.decision ?? j.hal_decision ?? j.verdict ?? '').toLowerCase(); return !d ? 'no decision in the reply' : c.want(d, j) ? null : `${c.says}; got ${d}`; },
    (j) => `decision ${j.decision ?? j.hal_decision ?? j.verdict}${j.cached ? ' (cached)' : ''}${r.ms ? `, ${r.ms} ms` : ''}`);
}

const failed = legs.filter((l) => l.outcome === 'FAILED').length, verified = legs.filter((l) => l.outcome === 'VERIFIED').length;
const code = failed ? 1 : PLANT ? 3 : verified ? 0 : 2; // a planted run never exits 0: it is a rehearsal
if (JSON_OUT) console.log(JSON.stringify({ planted: PLANT ?? null, base: OFFLINE ? `offline:${OFFLINE}` : BASE, agent: AGENT, at: new Date().toISOString(), verified, failed, not_checked: legs.length - verified - failed, exit: code, legs }, null, 1));
else {
  console.log(`trust backend conformance · ${OFFLINE ? `offline fixtures ${OFFLINE}` : BASE} · agent ${AGENT}`);
  if (PLANT) console.log(`  PLANTED DEFECT (--plant ${PLANT}): ${PLANTS[PLANT][2]}. This run is a rehearsal; a correct check must show FAILED below.`);
  for (const l of legs) console.log(`  ${l.outcome.padEnd(11)} ${l.name}: ${l.detail}`);
  console.log(`${verified} verified, ${failed} failed, ${legs.length - verified - failed} not checked`);
}
process.exit(code);
