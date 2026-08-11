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
 * machine you are sitting at, using the published @hyperdag/proof-verifier WASM — offline
 * and deterministically. Measured ~65 ms wall clock for all four verifications on an
 * x86_64 container (1 honest + 3 tampers, including Node startup). It then TAMPERS with
 * the statement and shows the
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
 *   npx @hyperdag/trust-demo                 everything keyless: local crypto + live reads
 *   npx @hyperdag/trust-demo --offline       only the local proof check (no network)
 *   npx @hyperdag/trust-demo --agent <slug>  a different agent (default trinity-shofet)
 *   npx @hyperdag/trust-demo --hal           also consult HAL (needs REPID_API_KEY to
 *                                            beat the per-IP cap; runs automatically
 *                                            when that key is set)
 *   npx @hyperdag/trust-demo --json          machine-readable, same data
 *
 * Exit codes: 0 every attempted leg passed · 1 a leg that RAN produced a failure
 *             (e.g. a proof was rejected) · 2 nothing could be checked at all.
 *             A leg that was SKIPPED or came back UNKNOWN is not an error — but it is
 *             also never counted as a pass.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyProofLocally, missingStatementFields, halRequestHeaders } from '../src/verify-local.mjs';
import { safe, wasUnsafe } from '../src/safe-output.mjs';
import { maySendKey } from '../src/engine-trust.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

// Some Node 18.x/20.x builds print "ExperimentalWarning: The Fetch API is an experimental
// feature" on the first fetch — noise about Node's own API maturity that says nothing about
// what this tool verified, landing mid-output on versions `engines` supports.
//
// HONESTY NOTE: not reproduced on 18.20.8 (checked with a bare fetch — no warning, with or
// without this shim), so on that build this is a no-op rather than a fix. Kept because it
// costs nothing and older patch releases in the supported range did emit it. Suppression is
// as narrow as it can be: this one warning, matched by type AND message. Every other
// warning, including any future deprecation, still reaches the user.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /Fetch API|buffer\.Blob/i.test(message)) return;
  return _emitWarning(warning, ...rest);
};

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('help') || has('h')) {
  // Bounded by the end of the header comment, not a hard-coded line number: the header
  // grew past 36 lines once already and silently truncated the exit-code documentation.
  const src = readFileSync(new URL('./trust-demo.mjs', import.meta.url), 'utf8').split('\n');
  const end = src.findIndex((l, i) => i > 0 && l.trim() === '*/');
  console.log(src.slice(1, end).map((l) => l.replace(/^ \* ?/, '').replace(/^ \*$/, '')).join('\n'));
  process.exit(0);
}

const OFFLINE = has('offline');
const AS_JSON = has('json');
const AGENT = flag('agent', 'trinity-shofet');
// A deliberately false statement, so a working quorum has something to actually catch.
const CLAIM = flag('claim', 'The Eiffel Tower is located in Rome, Italy.');
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

/**
 * A response bigger than this is not a response, it is a resource-exhaustion attempt.
 * The largest legitimate payload is a proof of ~15 KB of base64.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Records that an engine sent bytes a terminal would have interpreted. */
const tampering = [];

/** Walk a parsed body and flag any string that carried control characters. */
function detectTampering(url, value, depth = 0) {
  if (depth > 6 || tampering.length > 4) return;
  if (typeof value === 'string') {
    if (wasUnsafe(value)) tampering.push(url);
  } else if (Array.isArray(value)) {
    for (const v of value) detectTampering(url, v, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) detectTampering(url, v, depth + 1);
  }
}

/** Keyless GET with a timeout. Never throws — a dead network is a reported gap. */
async function get(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });

    // Read as text with a hard ceiling rather than res.json(), so a hostile or broken
    // engine cannot make this process allocate without bound.
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) {
      return { status: res.status, json: null, error: `response too large (${declared} bytes)` };
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      return { status: res.status, json: null, error: `response too large (${text.length} bytes)` };
    }

    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body stays null */ }
    if (json) detectTampering(url, json);
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
  // Name every leg we are NOT going to run. Without this the summary reads
  // "unknown: 0  skipped: 0", which looks like a clean sweep of the whole harness
  // rather than one leg out of six — the flattering reading, and the wrong one.
  for (const k of ['repid', 'live_proof', 'anchor', 'receipt', 'hal']) {
    result.legs[k] = { state: 'SKIPPED', reason: 'offline mode — no network calls attempted' };
  }
  await finish();
}

// ── 2. RepID ────────────────────────────────────────────────────────────────
step(2, `RepID — ${AGENT}'s live reputation (keyless read)`);
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/repid/${encodeURIComponent(AGENT)}`);
  if (status === 200 && json) {
    const score = json.repid_score ?? json.repid ?? null;
    result.legs.repid = { state: 'REAL', score, tier: json.tier ?? null };
    ok(`RepID ${safe(score)}   tier ${safe(json.tier ?? 'unknown')}`);
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
    unk(`the engine returned a legacy ${safe(json.scheme ?? 'stub')} row with no proof bytes — nothing to verify`);
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
        ok(`${safe(json.scheme)} — ${bytes} bytes fetched, VERIFIED LOCALLY (v${safe(v.verifierVersion)})`);
        note('we checked the math ourselves. The engine\'s own opinion was not consulted.');
      } else {
        result.legs.live_proof = { state: 'FAIL', verified: false, scheme: json.scheme, bytes, statement: json.statement, reason: v.reason };
        bad(`local verification FAILED — ${v.reason}`);
        note('a proof we could not verify is a gap, never a pass.');
      }
      if (json.eas?.anchored) note(`EAS attestation ${safe(json.eas.attestation_uid)} on ${safe(json.eas.network)}`);
    }
  }
}

// ── 4. On-chain anchor ──────────────────────────────────────────────────────
step(4, 'On-chain — the attestation anchor on Base Sepolia');
{
  const { status, json, error } = await get(`${ENGINE}/api/v1/observability/onchain-stats`);
  if (status === 200 && json) {
    // Field names confirmed against PRODUCTION on 2026-08-10: the endpoint returns
    // `lifetime_onchain_writes` and `agents_minted`. None of the names guessed from the
    // harness matched, so this leg fell through to dumping a raw JSON blob truncated
    // mid-string. Guessing an API's field names from a sibling script is not knowing them.
    const w = json.lifetime_onchain_writes ?? json.total_writes ?? json.writes ?? json.onchain_writes ?? null;
    const minted = json.agents_minted ?? null;
    const blob = safe(JSON.stringify(json), 80);
    result.legs.anchor = { state: 'REAL', writes: w, stats: json };
    ok(`on-chain reputation writes: ${w === null ? blob : safe(w)}${minted === null ? '' : `   agents minted: ${safe(minted)}`}`);
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
    // contract_id is server-controlled and ends up in a printed URL, so it is sanitised too.
    const url = `${ENGINE}/api/v1/receipt/${safe(json.contract_id ?? 'latest', 64)}`;
    result.legs.receipt = {
      state: 'REAL',
      contract_id: json.contract_id ?? null,
      price_usdc: json.price_usdc ?? null,
      settlement_tx: json.settlement_tx ?? null,
      paid_before_delivery: json.paid_before_delivery ?? null,
      url,
    };
    ok(`contract ${safe(String(json.contract_id ?? '').slice(0, 8))} settled for ${safe(json.price_usdc ?? '?')}`);
    if (json.settlement_url) note(`settlement tx: ${safe(json.settlement_url)}`);
    // The receipt is deliberately honest about exchanges that paid before delivery.
    if (json.paid_before_delivery === true) note('note: this exchange paid at escrow, BEFORE delivery — the receipt says so rather than smoothing it over.');
    note(`open in a browser (no key needed): ${url}`);
  } else {
    result.legs.receipt = { state: 'UNKNOWN', reason: error ?? `HTTP ${status}` };
    unk(`no receipt available — ${error ?? `HTTP ${status}`}`);
  }
}

// ── 6. HAL — opt-in ─────────────────────────────────────────────────────────
// OPT-IN ON PURPOSE, and this is the one design decision in this file worth arguing.
// HAL's cross-provider quorum is the only leg that needs a key: keyless callers hit
// HAL_PUBLIC_RATE_LIMIT and get a 429. Running it by default would mean nearly every
// first-time `npx` run ends on a rate-limit gap that says nothing about the system —
// so it runs when you have a key (or ask for it with --hal), and otherwise says plainly
// that it was not consulted. "Not consulted" is a different thing from "passed", and the
// summary keeps them different.
// CREDENTIAL SAFETY. halRequestHeaders attaches REPID_API_KEY as a bearer token. `--engine`
// lets anyone retarget this CLI, so `npx @hyperdag/trust-demo --engine https://evil.example`
// with the key in the environment would hand that key to a stranger — an exfiltration
// primitive shipped inside a security demo. The token therefore only travels to the
// official origin unless the user opts in explicitly for their own deployment.
// Origin comparison lives in src/engine-trust.mjs so it is unit-tested rather than
// eyeballed — `…up.railway.app.evil.com` defeats a startsWith check.
const keyPolicy = maySendKey(ENGINE, { optIn: has('send-key-to-custom-engine') });
const engineOrigin = keyPolicy.origin;
const keyAllowedHere = keyPolicy.allowed;
const rawHalAuth = halRequestHeaders(process.env);
const halAuth = rawHalAuth.authenticated && !keyAllowedHere
  ? { headers: { 'content-type': 'application/json' }, authenticated: false }
  : rawHalAuth;
const keyWithheld = rawHalAuth.authenticated && !keyAllowedHere;
const halRequested = halAuth.authenticated || has('hal');
step(6, 'HAL — cross-provider hallucination quorum (opt-in; needs a key)');
if (keyWithheld) {
  unk(`REPID_API_KEY withheld: --engine points at ${safe(engineOrigin ?? ENGINE)}, not the official origin`);
  note('a key is only sent to the official engine. Pass --send-key-to-custom-engine if that');
  note('host is genuinely yours. Running keyless instead — never silently, and never leaked.');
}
if (!halRequested) {
  result.legs.hal = { state: 'SKIPPED', reason: 'not requested — no REPID_API_KEY and no --hal' };
  note('not consulted. This leg needs REPID_API_KEY to bypass the public per-IP cap.');
  note('set REPID_API_KEY=… (or pass --hal to try keyless and see the cap for yourself)');
  note('NOT consulted is not the same as passed — the summary below keeps them apart.');
} else {
  if (halAuth.authenticated) note('authenticated (REPID_API_KEY present) — bypasses the per-IP cap, so the quorum runs');
  else note('keyless by request (--hal) — expect HAL_PUBLIC_RATE_LIMIT to cap this');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(TIMEOUT_MS, 90_000));
  try {
    const res = await fetch(`${ENGINE}/api/v1/hal/evaluate`, {
      method: 'POST',
      headers: halAuth.headers,
      body: JSON.stringify({ text: CLAIM, context: { domain: 'general', certainty: 0.8 }, strictness: 2 }),
      signal: ac.signal,
    });
    if (res.status === 429) {
      // A rate limit is NOT a verdict. Saying so is the whole discipline.
      result.legs.hal = {
        state: 'UNKNOWN',
        reason: halAuth.authenticated
          ? 'rate limited despite an API key (HAL_PUBLIC_RATE_LIMIT) — key not on the allowlist?'
          : 'rate limited (HAL_PUBLIC_RATE_LIMIT, per IP) — set REPID_API_KEY to bypass',
      };
      unk(`rate limited — HAL could not be consulted`);
      note('this is NOT a pass.');
    } else if (!res.ok) {
      result.legs.hal = { state: 'UNKNOWN', reason: `HTTP ${res.status}` };
      unk(`HAL unavailable — HTTP ${res.status}`);
    } else {
      const j = await res.json();
      const verdict = j.verdict ?? j.decision ?? null;
      const halScore = j.halScore ?? j.hal_score ?? null;
      result.legs.hal = { state: 'REAL', verdict, halScore, mode: j.mode ?? null, calibrated: false };
      const vetoed = /veto/i.test(String(verdict));
      // A VETO is HAL WORKING — the default claim is deliberately false, so catching it is
      // the success case. Rendering it with bad() painted it red as "FAIL", which collides
      // with FAIL-the-leg-state and tells the reader the opposite of what happened.
      ok(`verdict ${safe(verdict)}   halScore ${safe(halScore)}   mode ${safe(j.mode ?? '?')}`);
      if (vetoed) note('VETO = the quorum caught the false claim. That is the system working, not a failure.');
      // LESSONS #8: a measurement without its ruler is not a result. The raw halScore is
      // NOT a probability — on the frozen holdout, cases scoring 0.50 were hallucinations
      // 83-88% of the time. Calibration needs the frozen calibrator artefact, which lives
      // in the repo and is deliberately not vendored here (it would drift silently). So
      // the raw number is shown and labelled raw, and the calibrated one is pointed at.
      note('halScore above is RAW and uncalibrated — it is not a probability.');
      note('for the calibrated P(hallucination) with its ruler, run scripts/demo/trust-harness-e2e.mjs');
      if (Array.isArray(j.evidence) && j.evidence.length) {
        note('per-provider evidence:');
        for (const e of j.evidence.slice(0, 5)) note(`  - ${safe(e)}`);
      }
    }
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timed out' : String(e?.message ?? e);
    result.legs.hal = { state: 'UNKNOWN', reason };
    unk(`HAL unreachable — ${reason}`);
  } finally {
    clearTimeout(t);
  }
}

await finish();

/** Truncate any string in the tree, in place, so one hostile field cannot balloon output. */
function boundStrings(node, max = 2000, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v.length > max) {
      node[k] = `${v.slice(0, max)}… [truncated ${v.length - max} chars]`;
    } else if (v && typeof v === 'object') {
      boundStrings(v, max, depth + 1);
    }
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
async function finish() {
  const legs = Object.entries(result.legs);
  const real = legs.filter(([, l]) => l.state === 'REAL');
  const failed = legs.filter(([, l]) => l.state === 'FAIL');
  const unknown = legs.filter(([, l]) => l.state === 'UNKNOWN');
  const skipped = legs.filter(([, l]) => l.state === 'SKIPPED');

  // Three distinct words, because collapsing them is how a demo starts lying:
  //   REAL    — ran, produced a result
  //   FAIL    — ran, produced a bad result (this is an error; exit 1)
  //   UNKNOWN — tried, could not get an answer
  //   SKIPPED — deliberately not attempted (opt-in, not requested)
  // A SKIPPED HAL is not a passing HAL, so the scope line says which one happened rather
  // than quietly implying the harness ran end to end.
  const halState = result.legs.hal?.state ?? 'SKIPPED';
  const scope =
    halState === 'REAL'
      ? 'keyless subset + HAL consulted — still NOT an action-authorisation verdict (the dual-auth gate needs the standards hash and the fold; run scripts/demo/trust-harness-e2e.mjs)'
      : halState === 'UNKNOWN'
        ? 'keyless subset — HAL was attempted and could not answer, which is not a pass; this is not an action-authorisation verdict'
        : 'keyless subset — HAL not consulted (opt-in); this is not an action-authorisation verdict';

  result.summary = {
    verified_legs: real.map(([k]) => k),
    failed_legs: failed.map(([k]) => k),
    unknown_legs: unknown.map(([k]) => k),
    skipped_legs: skipped.map(([k]) => k),
    hal: halState,
    scope,
  };

  // Say it out loud. A sanitised attack is still an attack, and quietly cleaning up after
  // a hostile engine would be exactly the "hide the gap" behaviour this demo exists to
  // refuse. The output was made safe; the attempt is still news.
  result.tampering_detected = [...new Set(tampering)];

  // Bound every stored string before serialising. `safe()` guards what we PRINT, but the
  // result object holds raw server values, so `--json` could still emit megabytes of a
  // hostile field. Found by the adversarial fuzzer: one response produced 182 KB of JSON.
  // Control characters are already inert here (JSON.stringify escapes them), so this is
  // purely about size — the values stay faithful up to the bound, and say when they were cut.
  boundStrings(result);

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
    line(`  verified: ${real.length}   failed: ${failed.length}   unknown: ${unknown.length}   skipped: ${skipped.length}`);
    if (unknown.length) {
      line('');
      note('gaps, named rather than hidden:');
      for (const [k, l] of unknown) note(`  - ${k}: ${l.reason}`);
    }
    if (skipped.length) {
      line('');
      note('not attempted:');
      for (const [k, l] of skipped) note(`  - ${k}: ${l.reason}`);
    }
    if (result.tampering_detected.length) {
      line('');
      line(`  ${RED('!!')} this engine sent terminal escape sequences in ${result.tampering_detected.length} response(s).`);
      note('they were stripped before printing, so what you read above is what arrived.');
      note('a legitimate engine has no reason to do this. Treat this deployment as hostile:');
      for (const u of result.tampering_detected) note(`  - ${safe(u)}`);
    }
    line('');
    note(result.summary.scope);
    line('');
  }

  // A leg that RAN and failed is an error. A leg that could not run is not.
  //
  // FLUSH BEFORE EXITING. `process.exit()` discards whatever is still buffered in stdout,
  // and when stdout is a PIPE that buffer is only 64 KB — so `trust-demo --json | jq` was
  // silently emitting truncated, invalid JSON on any large output. Measured: 65,536 bytes
  // delivered out of 300,009 written. Found by the adversarial fuzzer, not by reading.
  // Writing a final empty chunk with a callback guarantees the ordered writes ahead of it
  // have reached the pipe before we tear the process down.
  const code = failed.length > 0 ? 1 : real.length === 0 ? 2 : 0;
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
}
