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

// ── LEG 3 — the reputation ledger's arithmetic closes ───────────────────────
//
// This leg USED to be `to - from === delta`, and that is not the engine's
// accounting. `repid_before` is written PRE-decay and `repid_after` is
// clamp(decayed + delta), so the real identity is
//
//     to === clamp(from - decay + delta),  clamp to [10, 10000]
//
// Decay and the clamp both move a score without appearing in `delta`. The old
// check was therefore testing "was decay zero and did the clamp stay out of the
// way", and on the first exchange where either is false it would have reported
// FAILED — accusing an honest ledger of a rewrite. Measured against the live
// ledger on 2026-09-04: it holds on all 1,339 contract-linked events, because
// no contract-linked event has yet decayed or clamped. A check that passes only
// because its hard case has not happened yet is a check that fails the day it
// does, so it is fixed here rather than after the first false accusation.
//
// What survives with full force is the direction rule. Decay only ever LOWERS a
// score, and the only thing that can lift one above its own delta is the floor,
// which lands exactly on 10. So unexplained UPWARD movement that is not at the
// floor is impossible on honest data — that stays FAILED.
const REPID_FLOOR = 10;
const REPID_CAP = 10000;
const clampRepId = (n) => Math.max(REPID_FLOOR, Math.min(REPID_CAP, n));

function checkRepIdLedger(r) {
  const events = r.reputation_events ?? [];
  if (events.length === 0) {
    return record('reputation ledger arithmetic', 'NOT_CHECKED', 'no reputation events on this receipt');
  }

  const last = {};
  const failed = [];
  const undetermined = [];
  let closed = 0;

  for (const e of events) {
    const where = `${e.agent}/${e.event}`;

    // Continuity: this agent's previous event must end where this one starts.
    // Independent of decay, so it is checkable on every receipt.
    if (last[e.agent] !== undefined && last[e.agent] !== e.from) {
      failed.push(`${e.agent}: the previous event ended at ${last[e.agent]} but the next starts at ${e.from}`);
    }
    last[e.agent] = e.to;

    // A recorded score outside the published range is wrong whatever the delta.
    if (e.to < REPID_FLOOR || e.to > REPID_CAP) {
      failed.push(`${where}: ${e.to} is outside the published [${REPID_FLOOR}, ${REPID_CAP}] range`);
      continue;
    }

    // Decay recorded => the identity is fully determined, so decide it.
    if (typeof e.decay === 'number') {
      if (e.decay < 0) {
        failed.push(`${where}: decay of ${e.decay} is negative, and decay can only lower a score`);
        continue;
      }
      const expected = clampRepId(e.from - e.decay + e.delta);
      if (expected !== e.to) {
        failed.push(
          `${where}: clamp(${e.from} - ${e.decay} + ${e.delta}) = ${expected}, but the ledger records ${e.to}`,
        );
        continue;
      }
      closed++;
      continue;
    }

    // No decay recorded. Decide what can still be decided.
    const excess = e.to - e.from - e.delta;
    if (excess === 0) {
      closed++;
    } else if (excess > 0 && e.to !== REPID_FLOOR) {
      failed.push(
        `${where}: ${e.from}->${e.to} is ${excess} MORE than its recorded delta of ${e.delta}, and ${e.to} is ` +
          `not the ${REPID_FLOOR} floor — nothing in the engine lifts a score above its own delta`,
      );
    } else if (excess > 0) {
      closed++; // at the floor: the clamp lifting it is the one legitimate cause
    } else {
      undetermined.push(`${where}: ${e.from}->${e.to} is ${-excess} LESS than its recorded delta of ${e.delta}`);
    }
  }

  if (failed.length > 0) return record('reputation ledger arithmetic', 'FAILED', failed.join('; '));
  if (undetermined.length > 0) {
    return record(
      'reputation ledger arithmetic',
      'NOT_CHECKED',
      `${closed} of ${events.length} event(s) close exactly. The rest moved DOWN by more than their delta, which ` +
        `decay or the ${REPID_CAP} cap would also do — and this receipt records no decay for them, so an honest ` +
        `decay cannot be told from a rewrite: ${undetermined.join('; ')}`,
    );
  }
  record(
    'reputation ledger arithmetic',
    'VERIFIED',
    `${events.length} event(s) chain continuously per agent and every score lands exactly where its own ` +
      `from/decay/delta put it, inside [${REPID_FLOOR}, ${REPID_CAP}]`,
  );
}

// ── LEG 3b — was the delta EARNED? ─────────────────────────────────────────
//
// The leg above proves the BOOKS BALANCE. It does not prove the amount was the
// amount the rules allow, and those are different claims that a reader will
// merge if only the first is printed. An agent that recorded +500 for work
// worth +20 passes every other leg of this receipt: its arithmetic closes, its
// chain is continuous, its work statement hashes, its money moved.
//
// Nothing here can close that gap. The three event types a receipt can carry
// (SERVICE_FULFILLED, SERVICE_SATISFIED, VALIDATION_FAILED — measured against
// the live ledger 2026-09-04) have no published tariff; their magnitudes come
// out of the service-contract scorer. Checking them against a number the
// receipt itself supplies would be circular, so this leg states the limit
// instead of inventing a check that would pass by construction.
function checkRepIdEntitlement(r) {
  const events = r.reputation_events ?? [];
  if (events.length === 0) return; // leg 3 already said so
  record(
    'reputation delta earned',
    'NOT_CHECKED',
    `the books balance, but nothing on this receipt shows the ${events.length} recorded delta(s) are the amounts ` +
      `the rules allow — those magnitudes come from a scorer whose parameters are not published here. Read the ` +
      `leg above as "the ledger was not rewritten", never as "the reputation was earned".`,
  );
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
checkRepIdLedger(receipt);
checkRepIdEntitlement(receipt);
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
