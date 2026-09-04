#!/usr/bin/env node
//
// verify-trust-receipt.mjs — check a public trust receipt WITHOUT trusting us.
//
// Usage:
//   node scripts/verify-trust-receipt.mjs                     # latest receipt
//   node scripts/verify-trust-receipt.mjs <contract-id>
//   node scripts/verify-trust-receipt.mjs --url <receipt.json url>
//   node scripts/verify-trust-receipt.mjs --file receipt.json  # fully offline
//   RPC_URL=https://sepolia.base.org  ...                      # enables leg 3
//
// DELIBERATELY STANDALONE. No imports from this repo, no dependencies. A
// verifier that shares code with the thing it verifies proves that the code
// agrees with itself. This one re-implements the canonical text from the SQL
// definition, so agreement is evidence. `tests/work-statement-canonical.test.ts`
// cross-checks the in-repo port against the SAME live-database oracle, and both
// must match it independently.
//
// THREE OUTCOMES PER LEG. VERIFIED / NOT_CHECKED / FAILED. A leg that could not
// run — no RPC configured, no work statement published, a legacy contract with
// no hash — is NOT_CHECKED. It is never silently a pass, and never a failure
// either: "I could not look" is not "I looked and it was wrong". Exit code is
// 0 only if nothing FAILED and at least one leg VERIFIED; 1 if anything FAILED;
// 2 if nothing could be checked at all.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULT_BASE = process.env.RECEIPT_BASE ?? 'https://repid-engine-production.up.railway.app';
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const legs = [];
const record = (name, outcome, detail) => legs.push({ name, outcome, detail });

// ── the receipt ──────────────────────────────────────────────────────────────
async function loadReceipt() {
  const file = flag('--file');
  if (file) return { receipt: JSON.parse(readFileSync(file, 'utf8')), source: `file://${file}` };
  const url =
    flag('--url') ??
    (argv[0] && !argv[0].startsWith('--')
      ? `${DEFAULT_BASE}/api/v1/receipt/${argv[0]}.json`
      : `${DEFAULT_BASE}/api/v1/receipt/latest.json`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`receipt fetch failed: HTTP ${res.status} from ${url}`);
  return { receipt: await res.json(), source: url };
}

// ── LEG 1 — the work statement hashes to what the contract stored ────────────
// Transcribed from public.work_statement_canonical_text(jsonb). Fixed field
// order, no whitespace, criteria sorted by n.
function canonicalText(ws) {
  const crit = [...(ws.acceptance_criteria ?? [])]
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map((c) => `{"n":${Number(c.n)},"text":${JSON.stringify(String(c.text))}}`)
    .join(',');
  return (
    `{"acceptance_criteria":[${crit}]` +
    `,"agreed_price":{"amount_usdc_raw":${ws.agreed_price.amount_usdc_raw}` +
    `,"currency":${JSON.stringify(String(ws.agreed_price.currency))}}` +
    `,"deadline":${JSON.stringify(String(ws.deadline))}` +
    `,"deliverable":${JSON.stringify(String(ws.deliverable))}}`
  );
}
const wsHash = (ws) => '0x' + createHash('sha256').update(Buffer.from(canonicalText(ws), 'utf8')).digest('hex');

function checkWorkStatement(r) {
  if (!r.work_statement) {
    return record('work statement binding', 'NOT_CHECKED',
      r.work_statement_hash
        ? 'the receipt publishes a hash but no statement — nothing to recompute from'
        : 'this contract settled before work-statement binding existed');
  }
  if (!r.work_statement_hash) {
    return record('work statement binding', 'NOT_CHECKED', 'no stored hash to compare against');
  }
  const expected = wsHash(r.work_statement);
  if (expected !== r.work_statement_hash) {
    return record('work statement binding', 'FAILED',
      `recomputed ${expected} but the contract stores ${r.work_statement_hash} — the agreed spec was altered after it was bound`);
  }
  record('work statement binding', 'VERIFIED',
    'the published spec hashes to the stored value; it has not been edited since binding');
}

// ── LEG 2 — the satisfaction score is derived, not asserted ──────────────────
function checkScore(r) {
  const ratings = r.criterion_ratings;
  if (!Array.isArray(ratings) || ratings.length === 0) {
    return record('satisfaction score', 'NOT_CHECKED', 'no per-criterion ratings published');
  }
  if (r.buyer_satisfaction_score === null || r.buyer_satisfaction_score === undefined) {
    return record('satisfaction score', 'NOT_CHECKED', 'no score recorded on the contract');
  }
  const met = ratings.filter((x) => x.met === true).length;
  const expected = (met / ratings.length).toFixed(4);
  const stored = Number(r.buyer_satisfaction_score).toFixed(4);
  if (expected !== stored) {
    return record('satisfaction score', 'FAILED',
      `stored ${stored} is not round(${met}/${ratings.length}, 4) = ${expected} — the score was asserted, not derived`);
  }
  record('satisfaction score', 'VERIFIED', `exactly round(${met}/${ratings.length}, 4) = ${expected}`);
}

// ── LEG 3 — the reputation ledger chains ────────────────────────────────────
// Offline and worth doing: each agent's events must run from -> to with no gap.
// A rewritten delta shows up as a break in the chain.
function checkRepIdChain(r) {
  const events = r.reputation_events ?? [];
  if (events.length === 0) return record('reputation chain', 'NOT_CHECKED', 'no reputation events on this receipt');
  const last = {};
  const breaks = [];
  for (const e of events) {
    if (e.to - e.from !== e.delta) breaks.push(`${e.agent}/${e.event}: ${e.from}->${e.to} is not a delta of ${e.delta}`);
    if (last[e.agent] !== undefined && last[e.agent] !== e.from) {
      breaks.push(`${e.agent}: previous event ended at ${last[e.agent]} but the next starts at ${e.from}`);
    }
    last[e.agent] = e.to;
  }
  if (breaks.length > 0) return record('reputation chain', 'FAILED', breaks.join('; '));
  record('reputation chain', 'VERIFIED',
    `${events.length} event(s) chain continuously per agent, and every delta matches its own from/to`);
}

// ── LEG 4 — the transactions exist on chain ─────────────────────────────────
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
}

async function checkChain(r) {
  const url = process.env.RPC_URL;
  const txs = [['settlement tx', r.settlement_tx], ['reputation attestation tx', r.onchain_tx]].filter((t) => t[1]);
  if (txs.length === 0) return record('on-chain', 'NOT_CHECKED', 'the receipt names no transactions');
  if (!url) {
    return record('on-chain', 'NOT_CHECKED',
      `set RPC_URL to a Base Sepolia endpoint to check ${txs.length} transaction(s). Not checking is not a pass.`);
  }
  for (const [label, tx] of txs) {
    try {
      const receipt = await rpc(url, 'eth_getTransactionReceipt', [tx]);
      if (!receipt) { record(label, 'FAILED', `${tx} is not on chain at ${url}`); continue; }
      if (receipt.status !== '0x1') { record(label, 'FAILED', `${tx} reverted (status ${receipt.status})`); continue; }
      record(label, 'VERIFIED', `mined in block ${parseInt(receipt.blockNumber, 16)}, status success`);
    } catch (err) {
      // Could not reach the chain. That says nothing about the transaction.
      record(label, 'NOT_CHECKED', `RPC unreachable (${String(err.message ?? err)}) — this is not a verdict on ${tx}`);
    }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const GLYPH = { VERIFIED: 'ok  ', NOT_CHECKED: '??  ', FAILED: 'FAIL' };

let receipt, source;
try {
  ({ receipt, source } = await loadReceipt());
} catch (err) {
  console.error(`NOT_CHECKED — could not load a receipt: ${err.message}`);
  process.exit(2);
}

console.log(`Trust receipt ${receipt.contract_id}`);
console.log(`  source   ${source}`);
console.log(`  settled  ${receipt.settled_at ?? '(not settled)'}  ${receipt.price_usdc ?? ''}`);
console.log(`  parties  ${receipt.buyer} -> ${receipt.provider}`);
console.log('');

checkWorkStatement(receipt);
checkScore(receipt);
checkRepIdChain(receipt);
await checkChain(receipt);

for (const l of legs) console.log(`  ${GLYPH[l.outcome]} ${l.name.padEnd(28)} ${l.detail}`);

if (Array.isArray(receipt.caveats) && receipt.caveats.length > 0) {
  console.log('\n  The receipt states these limits itself:');
  for (const c of receipt.caveats) console.log(`    - ${c}`);
}

const failed = legs.filter((l) => l.outcome === 'FAILED');
const verified = legs.filter((l) => l.outcome === 'VERIFIED');
console.log('');
if (failed.length > 0) {
  console.log(`FAILED — ${failed.length} of ${legs.length} legs disagree with the receipt.`);
  process.exit(1);
}
if (verified.length === 0) {
  console.log(`NOT_CHECKED — nothing on this receipt could be checked. That is not a pass.`);
  process.exit(2);
}
console.log(`VERIFIED — ${verified.length} of ${legs.length} legs checked and consistent; ${legs.length - verified.length} NOT_CHECKED.`);
