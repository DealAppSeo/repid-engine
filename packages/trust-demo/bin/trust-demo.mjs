#!/usr/bin/env node
/**
 * trust-demo — one command, a real verified trust loop, no API key.
 *
 * WHAT THIS IS FOR. The trust harness has worked end to end for a while and nobody
 * outside the repo could see it: `scripts/demo/trust-harness-e2e.mjs` needs a TypeScript
 * build, a Rust binary at a hard-coded Windows path, and an API key before it will say
 * anything. This package is the part an outside developer can actually run.
 *
 * THE ONE LEG THAT NEEDS NOTHING. Step 1 verifies a genuine Plonky3 STARK proof on the
 * machine you are sitting at, using the published @hyperdag/proof-verifier WASM — offline,
 * deterministically, in about a second. It then TAMPERS with the statement and shows the
 * verifier rejecting it. That is the whole argument of the system reduced to something you
 * can check without trusting us, without a network, and without an account.
 *
 * The remaining legs read live production over keyless HTTP. They can be down; the
 * cryptography cannot.
 *
 * NOTHING HERE IS SIMULATED. Every leg either produces a real result from a real system
 * or reports UNKNOWN and says why. There is no mock, no fixture standing in for a live
 * value, and no fallback that invents one. A leg that cannot run is printed as a gap.
 *
 * THE BUNDLED PROOF IS SYNTHETIC, ON PURPOSE. `fixtures/leaf-rangecheck.synthetic.*` is a
 * real STARK proof generated offline over a fabricated witness (a NIL-variant UUID, a
 * made-up score). It is NOT a production extract — see the #376 fence in
 * scripts/hooks/prod-fixture-guard.js. Live agent data is fetched, never embedded.
 *
 * Usage:
 *   npx @hyperdag/trust-demo                 everything: local crypto + live reads
 *   npx @hyperdag/trust-demo --offline       only the local proof check (no network)
 *   npx @hyperdag/trust-demo --agent <slug>  a different agent (default trinity-shofet)
 *   npx @hyperdag/trust-demo --json          machine-readable, same data
 *
 * Exit codes: 0 every attempted leg passed · 1 a leg that RAN produced a failure
 *             (e.g. a proof was rejected) · 2 nothing could be checked at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyProofLocally, missingStatementFields } from '../src/verify-local.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('help') || has('h')) {
  console.log(readFileSync(new URL('./trust-demo.mjs', import.meta.url), 'utf8')
    .split('\n').slice(1, 36).map((l) => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '')).join('\n'));
  process.exit(0);
}

const OFFLINE = has('offline');
const AS_JSON = has('json');
const AGENT = flag('agent', 'trinity-shofet');
const ENGINE = flag('engine', process.env.TRUSTSHELL_API_URL || 'https://repid-engine-production.up.railway.app');
const TIMEOUT_MS = Number(flag('timeout', '15000'));

// ── presentation ────────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const B = (s) => c(1, s), DIM = (s) => c(2, s);
const GRN = (s) => c(32, s), RED = (s) => c(31, s), YEL = (s) => c(33, s);
const out = [];
const line = (s = '') => { if (!AS_JSON) console.log(s); };
const step = (n, t) => { line(''); line(B(`  ${n}. ${t}`)); };
const ok = (s) => line(`     ${GRN('OK')}    ${s}`);
const bad = (s) => line(`     ${RED('FAIL')}  ${s}`);
const unk = (s) => line(`     ${YEL('????')}  ${s}`);
const note = (s) => line(DIM(`           ${s}`));

const result = { engine: ENGINE, agent: AGENT, offline: OFFLINE, legs: {} };

/** Keyless GET with a timeout. Never throws — a dead network is a reported gap. */
async function get(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body stays null */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, error: e?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

// The real verifier. Loaded fail-closed: unavailable means the proof legs report
// UNKNOWN, never a byte-count pass.
let proofVerify = null;
let verifierLoadError = null;
try {
  ({ verify: proofVerify } = await import('@hyperdag/proof-verifier'));
} catch (e) {
  verifierLoadError = String(e?.message ?? e);
}

line('');
line(B('  HyperDAG trust demo') + DIM('  — verify it yourself; do not take our word for it'));
line(DIM(`  engine ${ENGINE}${OFFLINE ? '  (offline mode: not contacted)' : ''}`));

// ── 1. Local STARK verification ─────────────────────────────────────────────
// This is the leg that needs nothing from anyone. It runs the published WASM verifier
// over a real proof and then proves the verifier actually discriminates, by feeding it
// a tampered statement and showing the rejection. A verifier that accepts everything
// would pass the honest case too — so the honest case alone is not evidence.
step(1, 'A real STARK proof, verified on YOUR machine (offline, no key)');
if (!proofVerify) {
  result.legs.local_proof = { state: 'UNKNOWN', reason: `verifier failed to load — ${verifierLoadError}` };
  unk(`@hyperdag/proof-verifier failed to load — ${verifierLoadError}`);
} else {
  try {
    const meta = JSON.parse(readFileSync(path.join(FIXTURES, 'leaf-rangecheck.synthetic.json'), 'utf8'));
    const bytes = readFileSync(path.join(FIXTURES, 'leaf-rangecheck.synthetic.plonky3.bin')).toString('base64');
    const stmt = meta.statement;

    const honest = await verifyProofLocally({ proofBytes: bytes, statement: stmt, verifyFn: proofVerify });
    if (honest.verified) {
      ok(`proof VERIFIED locally by @hyperdag/proof-verifier v${honest.verifierVersion} (${honest.proofSizeBytes} bytes)`);
      note(`statement: ${JSON.stringify(stmt)}`);
      note('this ran on your CPU. No network call was made and no server was trusted.');
    } else {
      bad(`the bundled proof did NOT verify — ${honest.reason}`);
    }

    // Now show it REFUSES. Each tamper targets a different binding the proof claims.
    const tampers = [
      ['score changed', { ...stmt, repid_score: 99999 }],
      ['agent_id swapped', { ...stmt, agent_id: '00000000-0000-4000-8000-0000000000bb' }],
      ['threshold raised above the score', { ...stmt, threshold: 5000 }],
    ];
    const rejected = [];
    for (const [label, s] of tampers) {
      const r = await verifyProofLocally({ proofBytes: bytes, statement: s, verifyFn: proofVerify });
      rejected.push({ tamper: label, rejected: !r.verified, reason: r.reason });
      if (r.verified) bad(`TAMPER ACCEPTED (${label}) — the verifier is not discriminating`);
      else ok(`tamper rejected: ${label}`);
    }
    const allRejected = rejected.every((r) => r.rejected);
    result.legs.local_proof = {
      state: honest.verified && allRejected ? 'REAL' : 'FAIL',
      verified: honest.verified,
      verifierVersion: honest.verifierVersion,
      proofSizeBytes: honest.proofSizeBytes,
      statement: stmt,
      tampers: rejected,
      synthetic_fixture: true,
    };
    if (honest.verified && allRejected) {
      note('the proof is bound to THAT agent and THAT score — a proof minted for anyone else fails.');
    }
  } catch (e) {
    result.legs.local_proof = { state: 'UNKNOWN', reason: String(e?.message ?? e) };
    unk(`could not run the local check — ${e?.message ?? e}`);
  }
}

if (OFFLINE) {
  finish();
}

// ── 2. RepID ────────────────────────────────────────────────────────────────
step(2, `RepID — ${AGENT}'s live reputation (keyless read)`);
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/repid/${encodeURIComponent(AGENT)}`);
  if (status === 200 && json) {
    const score = json.repid_score ?? json.repid ?? null;
    result.legs.repid = { state: 'REAL', score, tier: json.tier ?? null };
    ok(`RepID ${score}   tier ${json.tier ?? 'unknown'}`);
  } else {
    result.legs.repid = { state: 'UNKNOWN', reason: error ?? `HTTP ${status}` };
    unk(`could not read RepID — ${error ?? `HTTP ${status}`}`);
  }
}

// ── 3. A LIVE proof, verified locally ───────────────────────────────────────
// Step 1 proved the verifier works. This proves it works on a proof THIS system minted
// for a real agent, fetched over the wire seconds ago.
step(3, 'That agent\'s live ZK proof — fetched, then verified locally');
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/repid/${encodeURIComponent(AGENT)}/proof`);
  if (status !== 200 || !json) {
    result.legs.live_proof = { state: 'UNKNOWN', reason: error ?? `HTTP ${status}` };
    unk(`no proof returned — ${error ?? `HTTP ${status}`}`);
  } else if (!json.proof_bytes) {
    result.legs.live_proof = { state: 'UNKNOWN', reason: 'legacy stub: no proof bytes', scheme: json.scheme ?? null };
    unk(`the engine returned a legacy ${json.scheme ?? 'stub'} row with no proof bytes — nothing to verify`);
  } else {
    const missing = missingStatementFields(json.statement);
    if (missing.length) {
      result.legs.live_proof = { state: 'UNKNOWN', reason: `statement missing ${missing.join(', ')}`, scheme: json.scheme };
      unk(`the statement is missing ${missing.join(', ')} — the verifier requires all of ${['agent_id', 'repid_score', 'threshold', 'tier'].join(', ')}`);
    } else {
      const v = await verifyProofLocally({ proofBytes: json.proof_bytes, statement: json.statement, verifyFn: proofVerify });
      const bytes = Buffer.from(json.proof_bytes, 'base64').length;
      if (v.verified) {
        result.legs.live_proof = { state: 'REAL', verified: true, scheme: json.scheme, bytes, statement: json.statement, verifierVersion: v.verifierVersion };
        ok(`${json.scheme} — ${bytes} bytes fetched, VERIFIED LOCALLY (v${v.verifierVersion})`);
        note('we checked the math ourselves. The engine\'s own opinion was not consulted.');
      } else {
        result.legs.live_proof = { state: 'FAIL', verified: false, scheme: json.scheme, bytes, statement: json.statement, reason: v.reason };
        bad(`local verification FAILED — ${v.reason}`);
        note('a proof we could not verify is a gap, never a pass.');
      }
      if (json.eas?.anchored) note(`EAS attestation ${json.eas.attestation_uid} on ${json.eas.network}`);
    }
  }
}

// ── 4. On-chain anchor ──────────────────────────────────────────────────────
step(4, 'On-chain — the attestation anchor on Base Sepolia');
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/observability/onchain-stats`);
  if (status === 200 && json) {
    const w = json.total_writes ?? json.writes ?? json.onchain_writes ?? null;
    result.legs.anchor = { state: 'REAL', writes: w, stats: json };
    ok(`on-chain reputation writes: ${w ?? JSON.stringify(json).slice(0, 80)}`);
  } else {
    result.legs.anchor = { state: 'UNKNOWN', reason: error ?? `HTTP ${status}` };
    unk(`anchor stats unavailable — ${error ?? `HTTP ${status}`}`);
  }
  note('IdentityRegistry   https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e');
  note('ReputationRegistry https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713');
}

// ── 5. Settlement receipt ───────────────────────────────────────────────────
step(5, 'A real settled exchange — the shareable receipt');
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/receipt/latest.json`);
  if (status === 200 && json) {
    const url = `${ENGINE}/api/v1/receipt/${json.contract_id ?? 'latest'}`;
    result.legs.receipt = {
      state: 'REAL',
      contract_id: json.contract_id ?? null,
      price_usdc: json.price_usdc ?? null,
      settlement_tx: json.settlement_tx ?? null,
      paid_before_delivery: json.paid_before_delivery ?? null,
      url,
    };
    ok(`contract ${String(json.contract_id ?? '').slice(0, 8)} settled for ${json.price_usdc ?? '?'}`);
    if (json.settlement_url) note(`settlement tx: ${json.settlement_url}`);
    // The receipt is deliberately honest about exchanges that paid before delivery.
    if (json.paid_before_delivery === true) note('note: this exchange paid at escrow, BEFORE delivery — the receipt says so rather than smoothing it over.');
    note(`open in a browser (no key needed): ${url}`);
  } else {
    result.legs.receipt = { state: 'UNKNOWN', reason: error ?? `HTTP ${status}` };
    unk(`no receipt available — ${error ?? `HTTP ${status}`}`);
  }
}

finish();

// ── summary ─────────────────────────────────────────────────────────────────
function finish() {
  const legs = Object.entries(result.legs);
  const real = legs.filter(([, l]) => l.state === 'REAL');
  const failed = legs.filter(([, l]) => l.state === 'FAIL');
  const unknown = legs.filter(([, l]) => l.state === 'UNKNOWN');

  result.summary = {
    verified_legs: real.map(([k]) => k),
    failed_legs: failed.map(([k]) => k),
    unknown_legs: unknown.map(([k]) => k),
    // Deliberately NOT called a gate decision. This command runs the KEYLESS subset of
    // the trust harness: HAL's cross-provider quorum is not part of it, so nothing here
    // is a safety verdict on an action. An unavailable check is not a passing check, and
    // a subset that passed is not the whole harness passing.
    scope: 'keyless subset — HAL quorum not included; this is not an action-authorisation verdict',
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    line('');
    line(B('  ─────────────────────────────────────────────────────────────'));
    if (result.legs.local_proof?.state === 'REAL') {
      line(`  ${GRN('A real STARK proof verified on your machine, and three tampered')}`);
      line(`  ${GRN('versions of it were rejected.')} ${DIM('That part needed no network and no key.')}`);
    }
    line('');
    line(`  verified: ${real.length}   failed: ${failed.length}   unknown: ${unknown.length}`);
    if (unknown.length) {
      line('');
      note('gaps, named rather than hidden:');
      for (const [k, l] of unknown) note(`  - ${k}: ${l.reason}`);
    }
    line('');
    note(result.summary.scope);
    line('');
  }

  // A leg that RAN and failed is an error. A leg that could not run is not.
  process.exit(failed.length > 0 ? 1 : real.length === 0 ? 2 : 0);
}
