#!/usr/bin/env node
'use strict';
//
// verify-offline.cjs — audit a kernel receipt ledger with the blockchain and our servers switched off.
//
//   node scripts/verify-offline/verify-offline.cjs <ledger.jsonl> [--owner 0x..] [--engine-signer 0x..] [--json]
//
// DELIBERATELY STANDALONE: node built-ins plus `ethers` (keccak256, EIP-712, ecrecover), nothing from
// this repo and nothing from the trustshell npm package. A verifier that shares code with the thing it
// verifies only proves the code agrees with itself; tests/verify-offline.test.ts checks this one against
// the kernel's own validateReceipt / verifyReceiptChain on ledgers the real kernel wrote.
//
// INPUT is the JSONL the kernel ledger writes (src/kernel/store.ts), one record per line:
//   {"kind":"policy","recorded_at":"…","policy":{"policy":{…},"signature":"0x…"}}
//   {"kind":"receipt","receipt":{…kernel-receipt/1…}}
// A receipt line MAY carry "engine_signature" (the detached EIP-191 block the DB index stores beside it).
//
// TRUST ANCHORS come from the auditor, never from the file: --owner is the wallet you expect to have
// signed the policy, --engine-signer the engine's published receipt-signing address. Without them those
// legs prove "some key signed this", which is reported as NOT_CHECKED for authorship.
//
// THREE OUTCOMES PER LEG: VERIFIED / FAILED / NOT_CHECKED. "I could not look" is never a pass.
// Exit 0 = nothing FAILED and something VERIFIED; 1 = something FAILED; 2 = nothing could be verified.

const { readFileSync } = require('node:fs');
const { keccak256, toUtf8Bytes, TypedDataEncoder, recoverAddress, verifyMessage, getAddress, isAddress } = require('ethers');

const DAY_S = 86_400;
const SETTLERS = ['holdout', 'known_answer', 'person'];
const ENGINE_SIG_TYPE = 'hyperdag.repid.receipt.signature.v1';
const SECP256K1_HALF_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n >> 1n;

// Sorted keys at every depth, no whitespace, arrays in order (src/services/owner-authorization.ts
// canonicalJson and receipt-signer.ts canonicalize agree on every value JSON.parse can produce).
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const hashOf = (v) => keccak256(toUtf8Bytes(canonical(v)));
const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

/** keccak256 of the canonical receipt with header.receipt_hash removed (src/kernel/receipt.ts receiptHash). */
function receiptHash(r) {
  const { receipt_hash: _omit, ...header } = r.header;
  return hashOf({ ...r, header });
}

// EIP-712 owner policy (src/kernel/policy.ts). v2 adds authorizedImplHashes and is used when bindings exist.
const POLICY_FIELDS = [
  { name: 'subject', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'actions', type: 'string[]' },
  { name: 'payees', type: 'address[]' }, { name: 'perTxRaw', type: 'uint256' }, { name: 'dailyRaw', type: 'uint256' },
  { name: 'totalRaw', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
];
function policyDigest(p) {
  const v2 = Array.isArray(p.authorized_impl_hashes) && p.authorized_impl_hashes.length > 0;
  const domain = { name: 'HyperDAG Kernel Owner Policy', version: v2 ? '2' : '1', chainId: 84532 };
  const fields = v2 ? [...POLICY_FIELDS, { name: 'authorizedImplHashes', type: 'string[]' }] : POLICY_FIELDS;
  const value = {
    subject: p.subject, owner: p.owner, actions: p.actions, payees: p.payees ?? [], perTxRaw: p.per_tx_raw,
    dailyRaw: p.daily_raw, totalRaw: p.total_raw, expiresAt: p.expires_at, nonce: p.nonce,
    ...(v2 ? { authorizedImplHashes: p.authorized_impl_hashes } : {}),
  };
  return TypedDataEncoder.hash(domain, { OwnerPolicy: fields }, value);
}

function lowS(sig) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const v = parseInt(sig.slice(130, 132), 16);
  const s = BigInt('0x' + sig.slice(66, 130));
  return (v === 27 || v === 28) && s !== 0n && s <= SECP256K1_HALF_N;
}

function actionPermitted(actions, tool) {
  if (tool.class === 'spend') return actions.includes('spend');
  if (tool.class === 'post') return actions.includes('post');
  return actions.includes('tool') || actions.includes(`tool:${tool.name}`);
}

function verifyLedger(text, opts = {}) {
  const legs = {};
  const leg = (name) => (legs[name] ??= { verified: 0, failed: [], not_checked: [] });
  const fail = (name, msg) => leg(name).failed.push(msg);
  const skip = (name, msg) => leg(name).not_checked.push(msg);
  const ok = (name) => leg(name).verified++;
  const pinnedOwner = opts.owner && isAddress(opts.owner) ? getAddress(opts.owner) : null;
  const pinnedEngine = opts.engineSigner && isAddress(opts.engineSigner) ? getAddress(opts.engineSigner) : null;

  // ── parse ──
  const records = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    try { records.push({ line: i + 1, ...JSON.parse(line) }); } catch { fail('structure', `line ${i + 1}: not JSON`); }
  });
  const receipts = [];
  const policies = new Map(); // digest -> { policy, signature, status, seq }
  records.forEach((rec, seq) => {
    if (rec.kind === 'receipt' && rec.receipt && rec.receipt.header) receipts.push({ ...rec, seq });
    else if (rec.kind === 'policy' && rec.policy && rec.policy.policy) {
      const p = rec.policy.policy;
      try { policies.set(policyDigest(p), { policy: p, signature: rec.policy.signature, seq, status: 'NOT_CHECKED' }); }
      catch (e) { fail('owner_policy_signature', `line ${rec.line}: policy cannot be encoded (${e.shortMessage ?? e.message})`); }
    } else fail('structure', `line ${rec.line}: unknown record`);
  });

  // ── 1. each receipt's hash matches its body ──
  for (const { receipt: r, line } of receipts) {
    if (receiptHash(r) === r.header.receipt_hash) ok('receipt_hashes');
    else fail('receipt_hashes', `line ${line}: receipt ${r.header.receipt_id} does not match its receipt_hash (edited)`);
  }

  // ── 2. the chain: each prev_hash names the entry before it ──
  const segment = receipts.length > 0 && receipts[0].receipt.header.prev_hash !== null;
  if (segment) skip('chain_links', 'the file starts mid-ledger: entries before its first receipt were not provided');
  for (let i = 1; i < receipts.length; i++) {
    const h = receipts[i].receipt.header;
    const prev = receipts[i - 1].receipt.header;
    if (h.prev_hash === prev.receipt_hash && h.prev_receipt_id === prev.receipt_id) ok('chain_links');
    else fail('chain_links', `line ${receipts[i].line}: prev_hash does not name the receipt before it (removed, reordered or inserted)`);
  }

  // ── 3. owner policies: the owner's wallet signed exactly this policy ──
  for (const [digest, e] of policies) {
    const sig = e.signature;
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) { e.status = 'FAILED'; fail('owner_policy_signature', `${digest.slice(0, 10)}: no signature`); continue; }
    if (sig.length !== 132) { skip('owner_policy_signature', `${digest.slice(0, 10)}: not a 65-byte EOA signature (a smart-wallet owner needs a chain call)`); continue; }
    let signer = null;
    try { signer = getAddress(recoverAddress(digest, sig)); } catch { /* falls through to FAILED */ }
    if (!lowS(sig) || signer === null || signer !== getAddress(e.policy.owner)) {
      e.status = 'FAILED';
      fail('owner_policy_signature', `${digest.slice(0, 10)}: the signature does not recover to the policy's owner ${e.policy.owner}`);
    } else if (pinnedOwner && signer !== pinnedOwner) {
      e.status = 'FAILED';
      fail('owner_policy_signature', `${digest.slice(0, 10)}: signed by ${signer}, not the owner you pinned (${pinnedOwner})`);
    } else {
      e.status = 'VERIFIED';
      ok('owner_policy_signature');
      if (!pinnedOwner) skip('owner_policy_signature', `${digest.slice(0, 10)}: ${signer} signed it; pass --owner to check that wallet is the one you expect`);
    }
  }

  // ── 4. cross-field invariants, per receipt and across the ledger ──
  const decisions = new Map(); // receipt_id -> ALLOW decision row
  const used = new Map(); // one-use key -> line
  for (const { receipt: r, line } of receipts) {
    const before = leg('invariants').failed.length;
    const bad = (msg) => fail('invariants', `line ${line}: ${msg}`);
    const d = r.decision, p = r.payment, v = r.verification;
    const allow = d.verdict === 'ALLOW';
    if (d.blocking !== !allow) bad('blocking must equal verdict !== ALLOW');
    if (p.status !== 'NOT_APPLICABLE' && !allow) bad(`payment ${p.status} on a ${d.verdict}`);
    if (d.executed && !allow) bad(`a ${d.verdict} cannot have executed`);
    if (allow && (d.checks.length === 0 || d.checks.some((c) => c.outcome !== 'PASS'))) bad('an ALLOW must rest on checks that all PASSED');
    if (!allow && d.reasons.length === 0) bad('a refusal must say why');
    if (allow && r.request.tool.class === 'spend' && (r.request.amount_raw === null || BigInt(r.request.amount_raw) > BigInt(d.limits.effective_per_tx_raw))) bad('allowed spend exceeds effective_per_tx_raw');
    if (v.verdict_label === 'SETTLED' && !SETTLERS.includes(v.settled_by)) bad('SETTLED without a settler (a vote never settles)');
    if (v.counts_toward_band_restore !== (v.grounded && v.same_domain && !v.is_simulated && v.verdict_label === 'SETTLED')) bad('counts_toward_band_restore is not derived');
    if (r.header.env.is_simulated && (!p.is_simulated || !v.is_simulated)) bad('a simulated run holds a leg that claims to be real');
    if (p.status === 'SETTLED' && p.settlement_evidence !== 'MEASURED') bad('SETTLED payment without a measured settlement');
    if (p.settlement_evidence === 'MEASURED' && (p.is_simulated || !p.tx_hash || !p.observed_amount_raw)) bad('MEASURED without a transaction and an observed amount');
    if (allow && !d.executed) {
      decisions.set(r.header.receipt_id, r);
      // ONE-USE (src/kernel/receipt.ts authorizationKey): a spend or post consumes its argument digest for good.
      if (r.request.tool.class === 'spend' || r.request.tool.class === 'post') {
        const key = `${r.subject.agent.agent_id}|${lc(r.request.args_hash)}`;
        if (used.has(key)) bad(`authorization reused: same agent and args_hash already ALLOWed at line ${used.get(key)} (a replay)`);
        else used.set(key, line);
      }
    }
    if (d.executed) {
      const dec = decisions.get(r.header.receipt_id);
      if (!dec) {
        if (segment) skip('invariants', `line ${line}: executed row whose decision row may sit before this file starts`);
        else bad('executed with no ALLOW decision row before it (ran without being authorized first)');
      } else if (canonical(dec.request) !== canonical(r.request) || dec.decision.policy.policy_hash !== d.policy.policy_hash) {
        bad('what ran differs from what was authorized (request or policy changed between decision and outcome)');
      }
    }
    if (leg('invariants').failed.length === before) ok('invariants');
  }

  // ── 5. every ALLOW sits inside a policy the owner signed ──
  const spends = []; // { agent, ts, amount, policy }
  for (const { receipt: r, line, seq } of receipts) {
    if (r.decision.verdict !== 'ALLOW') continue;
    const before = leg('within_policy').failed.length;
    const bad = (msg) => fail('within_policy', `line ${line}: ${msg}`);
    const hash = r.decision.policy.policy_hash;
    const e = hash ? policies.get(hash) : undefined;
    if (!e) { skip('within_policy', `line ${line}: allowed under policy ${String(hash).slice(0, 10)}, which this file does not contain`); continue; }
    const pol = e.policy;
    const ts = Math.floor(Date.parse(r.header.created_at) / 1000);
    if (e.status === 'FAILED') bad('allowed under a policy whose owner signature does not verify');
    if (e.status === 'NOT_CHECKED') skip('within_policy', `line ${line}: the policy's signature could not be checked offline`);
    if (e.seq > seq) bad('allowed before its policy was recorded');
    for (const [, other] of policies) {
      if (other.seq < seq && other.policy.subject === pol.subject && BigInt(other.policy.nonce) > BigInt(pol.nonce)) { bad('allowed under a superseded policy (a higher nonce was already recorded)'); break; }
    }
    if (pol.subject !== r.subject.agent.agent_id) bad('the policy names a different agent');
    if (lc(r.subject.owner.wallet) !== lc(pol.owner) || lc(r.decision.policy.signer) !== lc(pol.owner)) bad("the receipt's owner is not the policy's signer");
    if (!actionPermitted(pol.actions, r.request.tool)) bad(`action ${r.request.tool.class}:${r.request.tool.name} is not in the policy`);
    if (!(ts <= pol.expires_at)) bad('allowed after the policy expired');
    if (r.request.tool.class === 'spend') {
      const amt = BigInt(r.request.amount_raw ?? '0');
      if (!(pol.payees ?? []).some((x) => lc(x) === lc(r.request.payee))) bad(`payee ${r.request.payee} is not on the owner's list`);
      if (amt > BigInt(pol.per_tx_raw)) bad('amount over the per-transaction cap');
      if (!r.decision.executed) {
        spends.push({ agent: r.subject.agent.agent_id, ts, amount: amt, hash });
        const total = spends.filter((s) => s.hash === hash).reduce((a, s) => a + s.amount, 0n);
        const daily = spends.filter((s) => s.agent === r.subject.agent.agent_id && s.ts >= ts - DAY_S).reduce((a, s) => a + s.amount, 0n);
        if (total > BigInt(pol.total_raw)) bad('cumulative spend under this policy exceeds total_raw');
        if (daily > BigInt(pol.daily_raw)) bad('spend in the last 24h exceeds daily_raw');
      }
    }
    if (leg('within_policy').failed.length === before) ok('within_policy');
  }

  // ── 6. engine signatures: "this backend produced this receipt" ──
  for (const { receipt: r, line, engine_signature: b } of receipts) {
    if (!b) { skip('engine_signature', `line ${line}: unsigned (the kernel ledger carries no engine signature; header.signer is null)`); continue; }
    if (!pinnedEngine) { skip('engine_signature', `line ${line}: pass --engine-signer to check who signed it`); continue; }
    const bad = (msg) => fail('engine_signature', `line ${line}: ${msg}`);
    if (b.type !== ENGINE_SIG_TYPE || typeof b.signature !== 'string') { bad('not a receipt signature block'); continue; }
    if (hashOf(r) !== b.content_hash) { bad('receipt content does not match the signed content hash (edited after signing)'); continue; }
    if (!lowS(b.signature)) { bad('signature is not a canonical 65-byte EIP-191 signature'); continue; }
    let who = null;
    try { who = getAddress(verifyMessage(canonical({ v: 1, type: ENGINE_SIG_TYPE, content_hash: b.content_hash }), b.signature)); } catch { /* FAILED below */ }
    if (who !== pinnedEngine) { bad(`signed by ${who ?? 'nobody recoverable'}, not the engine signer you pinned`); continue; }
    if (b.key_id !== undefined && lc(b.key_id) !== lc(who)) { bad('key_id does not name the key that signed'); continue; }
    ok('engine_signature');
  }

  // ── 7. what this cannot see with the chain and our servers off ──
  for (const { receipt: r, line } of receipts) {
    if (r.payment.tx_hash) skip('payment_onchain', `line ${line}: tx ${r.payment.tx_hash.slice(0, 10)}… not looked up (chain off)`);
  }
  skip('offline_limits', 'whether the policy owner is the agent\'s registered owner (registry / ERC-8004: chain off)');
  skip('offline_limits', 'HAL verdict correctness, RepID, zkRepID proofs and EAS anchors (hosted services and chain off)');
  skip('offline_limits', 'completeness: a missing receipt never proves no action; dropped tail entries, or a full re-seal by whoever writes the ledger that stays inside the owner\'s caps, leave no trace without an external anchor or an engine signature');

  const summary = { verified: 0, failed: 0, not_checked: 0 };
  for (const l of Object.values(legs)) { summary.verified += l.verified; summary.failed += l.failed.length; summary.not_checked += l.not_checked.length; }
  const exitCode = summary.failed > 0 ? 1 : summary.verified > 0 ? 0 : 2;
  return { receipts: receipts.length, policies: policies.size, legs, summary, exitCode };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv.find((a, i) => !a.startsWith('--') && !['--owner', '--engine-signer'].includes(argv[i - 1]));
  if (!file) { console.error('usage: verify-offline.cjs <ledger.jsonl> [--owner 0x..] [--engine-signer 0x..] [--json]'); process.exit(2); }
  const out = verifyLedger(readFileSync(file, 'utf8'), { owner: flag('--owner'), engineSigner: flag('--engine-signer') });
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${file}: ${out.receipts} receipts, ${out.policies} policies (chain: OFF, hosted services: OFF)`);
    for (const [name, l] of Object.entries(out.legs)) {
      const verdict = l.failed.length ? 'FAILED' : l.verified ? 'VERIFIED' : 'NOT_CHECKED';
      console.log(`\n${verdict.padEnd(11)} ${name}  (${l.verified} verified, ${l.failed.length} failed, ${l.not_checked.length} not checked)`);
      for (const m of l.failed) console.log(`  FAILED      ${m}`);
      for (const m of l.not_checked) console.log(`  NOT_CHECKED ${m}`);
    }
    console.log(`\nRESULT ${out.exitCode === 0 ? 'PASS' : out.exitCode === 1 ? 'FAIL' : 'NOTHING VERIFIED'}: ${out.summary.verified} verified, ${out.summary.failed} failed, ${out.summary.not_checked} not checked`);
  }
  process.exit(out.exitCode);
}

module.exports = { verifyLedger, receiptHash, policyDigest, canonical };
if (require.main === module) main();
