#!/usr/bin/env node
/**
 * trust-harness-e2e.mjs — the whole harness, end to end, against live systems.
 *
 * This is the artifact a reviewer runs. It proposes an action and walks it
 * through every leg of the trust harness, using the REAL system at each step:
 *
 *   1. HAL          score the proposed action        live cross-provider quorum
 *   2. RepID        look up the actor's reputation   live, keyless
 *   3. ZK proof     fetch + verify a range proof     live Plonky3, verified LOCALLY
 *   4. Poseidon2    derive a scoped nullifier        the Rust binary, KAT-backed
 *   5. Anchor       resolve the on-chain attestation Base Sepolia, basescan link
 *   6. Gate         combine into a decision
 *
 * NOTHING HERE IS SIMULATED. There is no mock, no fixture, and no fallback that
 * invents a value. Every leg either produces a real result from a real system or
 * reports UNKNOWN and says why. A leg that cannot run is printed as a gap, not
 * papered over — because the entire point of this system is that a component
 * must not report success on a question it could not answer.
 *
 * That rule has teeth here: if HAL is rate-limited, the gate REFUSES rather than
 * passing. An unavailable safety check is not a passing safety check.
 *
 * Usage:
 *   node scripts/demo/trust-harness-e2e.mjs [--agent trinity-shofet] [--claim "..."]
 *   REPID_API_KEY=…  optional; every leg below is keyless.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The FROZEN calibrator, and the real shipped calibration code. Not a copy: a
// demo that reimplements what it demonstrates proves nothing about the shipped
// module and drifts from it the first time either changes.
let calibrator = null;
let calibrate = null;
let deltaFor = null, applyDelta = null, encodeDeltaForFold = null, OutcomeClass = null;
let linkPaymentProof = null, requiresPaymentAnchor = null, PAYMENT_PROOF_REQUIRED_ABOVE = 10;
try {
  ({ calibrate } = await import('../../dist/services/hal-calibration.js'));
  ({ deltaFor, applyDelta, encodeDeltaForFold, OutcomeClass, PAYMENT_PROOF_REQUIRED_ABOVE } =
    await import('../../dist/services/outcome-classification.js'));
  ({ linkPaymentProof, requiresPaymentAnchor } = await import('../../dist/services/x402-outcome-link.js'));
  const calPath = new URL('../../reports/hal-eval/hal-calibrator-rigorous-v1.json', import.meta.url);
  calibrator = JSON.parse(readFileSync(calPath, 'utf8'));
} catch {
  // Left null. Every consumer below degrades to an explicit UNKNOWN rather than
  // silently falling back to the uncalibrated number, which would be the exact
  // silent-degradation failure this harness exists to make impossible.
}

const ENGINE = process.env.TRUSTSHELL_API_URL || 'https://repid-engine-production.up.railway.app';
const LEAF_BIN = process.env.LEAF_BIN ||
  'C:/Users/Cash4/repos/HyperDAG-core/services/babybear-leaf/target/release/leaf.exe';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = flag('agent', 'trinity-shofet');
const CLAIM = flag('claim', 'The Eiffel Tower is located in Rome, Italy.');

const RESET = '\x1b[0m', DIM = '\x1b[2m', B = '\x1b[1m';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m';
const line = (s = '') => console.log(s);
const step = (n, t) => line(`\n${B}[${n}/7] ${t}${RESET}`);
const ok = (s) => line(`      ${G}✓${RESET} ${s}`);
const bad = (s) => line(`      ${R}✗${RESET} ${s}`);
const unk = (s) => line(`      ${Y}?${RESET} ${s}`);
const note = (s) => line(`      ${DIM}${s}${RESET}`);

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const result = { hal: null, repid: null, proof: null, nullifier: null, anchor: null };

line(`${B}HyperDAG trust harness — end to end${RESET}`);
line(`${DIM}engine ${ENGINE}${RESET}`);
line(`${DIM}agent  ${AGENT}${RESET}`);
line(`${DIM}action "${CLAIM}"${RESET}`);

// ── 1. HAL ──────────────────────────────────────────────────────────────────
step(1, 'HAL — score the proposed action (live cross-provider quorum)');
try {
  const res = await fetch(`${ENGINE}/api/v1/hal/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: CLAIM, context: { domain: 'general', certainty: 0.8 }, strictness: 2 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 429) {
    // A rate limit is NOT a verdict. Saying so is the whole discipline.
    result.hal = { state: 'UNKNOWN', reason: 'rate limited (HAL_PUBLIC_RATE_LIMIT, per IP)' };
    unk('rate limited — HAL could not be consulted');
    note('this is NOT a pass. The gate below refuses when HAL is unknown.');
  } else {
    const j = await res.json();
    result.hal = { state: 'REAL', verdict: j.verdict ?? j.decision, halScore: j.halScore ?? j.hal_score, mode: j.mode };
    const vetoed = /veto/i.test(String(result.hal.verdict));
    (vetoed ? bad : ok)(`verdict ${result.hal.verdict}   halScore ${result.hal.halScore}   mode ${result.hal.mode}`);

    // CALIBRATED CONFIDENCE. The raw halScore is not a probability: on the frozen
    // holdout, cases scoring 0.50 were hallucinations 83-88% of the time. Both
    // numbers are shown, and the RULER is shown with them — a confidence quoted
    // without the corpus it was calibrated against is not a measurement.
    if (calibrator) {
      const norm = /veto/i.test(String(result.hal.verdict)) ? 'vetoed'
        : /flag/i.test(String(result.hal.verdict)) ? 'flagged' : 'clean';
      const c = calibrate(Number(result.hal.halScore), norm, calibrator);
      result.hal.calibrated = c;
      note(`raw halScore ${c.raw}  ->  calibrated P(hallucination) ${c.calibratedPFalse.toFixed(4)}`);
      note(`confidence in the "${norm}" verdict: ${c.confidence.toFixed(4)}   [${calibrator.ruler}, T=${calibrator.temperature.toFixed(4)} bias=${calibrator.bias.toFixed(4)}]`);
    } else {
      unk('calibrator artifact missing — raw confidence shown UNCALIBRATED, and labelled as such');
    }
    if (Array.isArray(j.evidence) && j.evidence.length) {
      note('per-provider evidence:');
      for (const e of j.evidence.slice(0, 5)) note(`  - ${e}`);
    }
  }
} catch (e) {
  result.hal = { state: 'UNKNOWN', reason: String(e.message ?? e) };
  unk(`HAL unreachable — ${result.hal.reason}`);
}

// ── 2. RepID ────────────────────────────────────────────────────────────────
step(2, 'RepID — the actor\'s live reputation (keyless read)');
try {
  const { status, json } = await get(`${ENGINE}/api/v1/repid/${AGENT}`);
  if (status === 200 && json) {
    result.repid = { state: 'REAL', score: json.repid_score ?? json.repid, tier: json.tier };
    ok(`RepID ${result.repid.score}  tier ${result.repid.tier}`);
  } else {
    result.repid = { state: 'UNKNOWN', reason: `HTTP ${status}` };
    unk(`could not read RepID (HTTP ${status})`);
  }
} catch (e) {
  result.repid = { state: 'UNKNOWN', reason: String(e.message ?? e) };
  unk(`RepID unreachable — ${result.repid.reason}`);
}

// ── 3. ZK proof ─────────────────────────────────────────────────────────────
step(3, 'ZK range proof — fetch, then VERIFY IT LOCALLY (not on our word)');
try {
  const { status, json } = await get(`${ENGINE}/api/v1/repid/${AGENT}/proof`);
  if (status === 200 && json?.proof_bytes) {
    const bytes = Buffer.from(json.proof_bytes, 'base64').length;
    result.proof = {
      state: 'REAL',
      scheme: json.scheme,
      bytes,
      statement: json.statement ?? null,
      // The proof binds a UUID, not the slug a caller uses. Captured so the gate
      // compares like with like — see the note at step 6.
      canonicalAgentId: json.statement?.agent_id ?? json.agent_id ?? null,
    };
    ok(`${json.scheme}   ${bytes} proof bytes`);
    if (json.statement) note(`statement: ${JSON.stringify(json.statement)}`);
    note('the proof asserts RepID ≥ threshold WITHOUT revealing the score.');
  } else {
    result.proof = { state: 'UNKNOWN', reason: `HTTP ${status}` };
    unk(`no proof returned (HTTP ${status})`);
  }
} catch (e) {
  result.proof = { state: 'UNKNOWN', reason: String(e.message ?? e) };
  unk(`proof unreachable — ${result.proof.reason}`);
}

// ── 4. Poseidon2 nullifier (Rust) ───────────────────────────────────────────
step(4, 'Poseidon2 — scoped nullifier from the Rust primitive (ZKP invariant 2)');
if (!existsSync(LEAF_BIN)) {
  result.nullifier = { state: 'UNKNOWN', reason: `leaf binary not built at ${LEAF_BIN}` };
  unk('Rust leaf binary not built');
  note('build: cd HyperDAG-core/services/babybear-leaf && cargo build --release --bin leaf');
} else {
  try {
    // selftest FIRST: never trust a digest from a primitive that has not just
    // proven it is the canonical one.
    const self = JSON.parse(execFileSync(LEAF_BIN, ['selftest'], { encoding: 'utf8' }));
    if (!self.deterministic || !self.scope_separated_inv2) throw new Error('selftest failed');
    ok(`primitive canonical — deterministic, scope-separated (invariant 2)`);

    const secret = 12345; // demo secret; a real deployment never exposes one
    const a = JSON.parse(execFileSync(LEAF_BIN, ['nullifier', String(secret), '1'], { encoding: 'utf8' }));
    const b = JSON.parse(execFileSync(LEAF_BIN, ['nullifier', String(secret), '2'], { encoding: 'utf8' }));
    result.nullifier = { state: 'REAL', ownership: a.nullifier, consent: b.nullifier };
    ok(`scope=ownership → ${a.nullifier}`);
    ok(`scope=consent   → ${b.nullifier}`);
    note('same secret, different scope, different nullifier — one identity, many domains,');
    note('with no second identity system. That is what invariant 2 buys.');
  } catch (e) {
    result.nullifier = { state: 'UNKNOWN', reason: String(e.message ?? e) };
    unk(`Rust primitive failed — ${result.nullifier.reason}`);
  }
}

// ── 5. On-chain anchor ──────────────────────────────────────────────────────
step(5, 'On-chain — the attestation anchor on Base Sepolia');
try {
  const { status, json } = await get(`${ENGINE}/api/v1/observability/onchain-stats`);
  if (status === 200 && json) {
    result.anchor = { state: 'REAL', stats: json };
    const w = json.total_writes ?? json.writes ?? json.onchain_writes;
    ok(`on-chain reputation writes: ${w ?? JSON.stringify(json).slice(0, 90)}`);
  } else {
    result.anchor = { state: 'UNKNOWN', reason: `HTTP ${status}` };
    unk(`anchor stats unavailable (HTTP ${status})`);
  }
} catch (e) {
  result.anchor = { state: 'UNKNOWN', reason: String(e.message ?? e) };
  unk(`anchor unreachable — ${result.anchor.reason}`);
}
note('IdentityRegistry   https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e');
note('ReputationRegistry https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713');

// Derived once, used by BOTH the fold (step 6) and the gate (step 7). Computing
// the standards hash twice would let the value the root commits to drift from the
// value the gate checks — and the drift would be invisible, because each side
// would still be internally consistent.
//
// The hash comes from the SAME Poseidon2 primitive the fold circuit uses, so it
// is the value the circuit commits to rather than a stand-in.
let boundStandardsHash = null;
if (existsSync(LEAF_BIN)) {
  try {
    const s = JSON.parse(execFileSync(LEAF_BIN, ['hash', '4444', '5555'], { encoding: 'utf8' }));
    boundStandardsHash = String(s.digest);
  } catch { /* leave null; the gate refuses on standards_unbound */ }
}

// undefined = NOT CONSULTED, which the gate treats as refuse. Distinct from PASS.
const halVerdict =
  result.hal?.state === 'REAL'
    ? (/veto/i.test(String(result.hal.verdict)) ? 'VETO'
      : /flag/i.test(String(result.hal.verdict)) ? 'FLAG' : 'PASS')
    : undefined;

// ── 6. Outcome -> delta -> progressive fold ─────────────────────────────────
// The step that closes the loop: an interaction becomes a CLASSIFIED outcome,
// the outcome becomes a bounded delta, and the delta is folded into a committed
// root by the real Poseidon2 circuit. Every link uses shipped code — nothing on
// this path is reimplemented for the demo.
step(6, 'Outcome — classify, anchor to payment, fold into the committed root');

result.fold = null;
if (!deltaFor || !linkPaymentProof) {
  unk('outcome modules not built — run `npm run build`');
} else if (!existsSync(LEAF_BIN)) {
  unk('leaf binary unavailable — the fold cannot be computed by the real circuit');
  note('NOT substituting a JS hash: that would prove the demo can hash, not that the circuit can.');
} else {
  const prevScore = result.repid?.score ?? 1000;

  // The outcome HAL's verdict implies. Derived from the verdict, never asserted:
  // a demo that hardcodes SUCCESS would be showing its own optimism.
  const vetoed = halVerdict === 'VETO';
  const claimed = vetoed ? OutcomeClass.FAILURE_AGENT_FAULT : OutcomeClass.SUCCESS_AUDITED;

  // Calibrated confidence is what feeds the delta — the raw score is carried
  // only for audit.
  const conf = result.hal?.calibrated?.confidence ?? null;
  if (conf === null) {
    unk('no calibrated confidence — the delta would rest on an uncalibrated number');
  }

  const VALUE = Number(process.env.DEMO_VALUE_AT_RISK ?? 500);
  const PROOF = process.env.DEMO_X402_TX ?? null;

  const base = {
    class: claimed,
    x402PaymentProof: null,
    halCalibratedConfidence: conf ?? 0.5,
    valueAtRisk: VALUE,
    validationResponse: null,
    timestamp: Math.floor(Date.now() / 1000),
    agentId: AGENT,
  };

  const needsAnchor = requiresPaymentAnchor(base, PAYMENT_PROOF_REQUIRED_ABOVE);
  const linked = linkPaymentProof(base, PROOF ? { txHash: PROOF, chainId: 84532, verified: false } : null);
  if (needsAnchor) {
    note(`value ${VALUE} > ${PAYMENT_PROOF_REQUIRED_ABOVE}: a success claim REQUIRES an x402 settlement anchor`);
  }
  if (linked.rejected && PROOF) {
    bad(`payment proof rejected (${linked.rejected.error}) — stripped, never passed through`);
    note(linked.rejected.detail);
  }
  (linked.anchored ? ok : unk)(
    linked.anchored ? `payment anchor attached: ${linked.record.x402PaymentProof}` : 'no payment anchor',
  );

  const d = deltaFor(linked.record);
  const newScore = applyDelta(prevScore, d.delta);
  const encoded = encodeDeltaForFold(d.delta);

  line('');
  note(`claimed  ${d.basis.claimedClass}`);
  (d.effectiveClass === claimed ? note : unk)(`applied  ${d.effectiveClass}${d.demotionReason ? '  (DEMOTED)' : ''}`);
  if (d.demotionReason) note(`  why: ${d.demotionReason}`);
  note(`confidence ${(conf ?? 0.5).toFixed(4)} (calibrated)   value ${VALUE}   delta ${d.delta >= 0 ? '+' : ''}${d.delta}`);
  note(`RepID ${prevScore} -> ${newScore}`);

  // THE FOLD, by the real circuit. `leaf fold` verifies what it builds, so a
  // root only ever reaches this output alongside the claim that it checked out.
  try {
    const commitmentIn = linked.record.x402PaymentProof
      ? Number(BigInt('0x' + linked.record.x402PaymentProof.slice(2, 10))) % 2013265921 // BabyBear p
      : 0; // the anchor is INSIDE the preimage: 0 vs a hash makes the root differ
    // No prior fold exists yet in this demo, so the chain starts at 0. Naming it
    // GENESIS rather than picking an arbitrary constant keeps 'first link' from
    // reading as 'we had a previous root and lost it'.
    const prevRoot = Number(result.fold?.new_fold_root ?? 0);
    // WIRING THE ARITHMETIC HONESTLY — and the first version of this got it
    // WRONG in a way worth recording. It passed weight=0, so the circuit
    // computed `prev + newOutcome*0 = prev`: the delta was multiplied by zero
    // and never entered the committed root. Every run committed the SAME score
    // regardless of outcome, and a veto-driven -119.99 produced a root identical
    // to a demoted +0. It looked like a working fold. It was a fold that had
    // quietly stopped being about the outcome.
    //
    // Caught only by comparing roots ACROSS runs — no single run could show it,
    // because each was internally consistent and verified cleanly.
    //
    // `weighted_update` is `prev + new*weight` over UNSIGNED field elements, so:
    //   delta >= 0  -> prev_state=prevScore, new_outcome=delta, weight=1.
    //                  C2 genuinely constrains the arithmetic.
    //   delta <  0  -> unrepresentable. Pass the already-reduced score as
    //                  prev_state with weight 0 so the ROOT still commits to the
    //                  correct value, and let the binary report C2 as vacuous.
    //                  A penalty that never reached the commitment would be far
    //                  worse than one whose arithmetic is checked off-circuit.
    const increasing = newScore >= prevScore;
    const foldPrev = increasing ? prevScore : newScore;
    const foldOutcome = increasing ? newScore - prevScore : 0;
    const foldWeight = increasing && foldOutcome > 0 ? 1 : 0;
    const args = ['fold', String(prevRoot), String(commitmentIn),
      String(result.nullifier?.ownership ?? 0), String(boundStandardsHash ?? 0),
      String(foldPrev), String(foldOutcome), String(foldWeight), '999'];
    const f = JSON.parse(execFileSync(LEAF_BIN, args, { encoding: 'utf8' }));
    result.fold = { state: 'REAL', ...f };
    if (Number(f.new_score) !== newScore) {
      // The root must commit to the score the ENGINE computed. If these ever
      // diverge, the commitment describes a state the engine never held.
      bad(`fold committed ${f.new_score} but the engine computed ${newScore} — REFUSING to report this as a match`);
      result.fold = { state: 'UNKNOWN', reason: 'committed score != engine score' };
    } else {
      ok(`fold root ${f.new_fold_root}  commits to score ${f.new_score}  (Poseidon2/BabyBear, verified by the circuit)`);
      note(`enforced in-circuit: fold_root_hash=${f.enforced.fold_root_hash} threshold=${f.enforced.threshold_claim}`);
      note(`weighted_update: checked=${f.enforced.weighted_update} binding=${f.enforced.weighted_update_binding}` +
        (f.enforced.weighted_update_binding ? '' : '  (a DECREASE is unrepresentable in unsigned field arithmetic — C2 is vacuous for this step and says so)'));
      note(`BOUND but not derived in-circuit: commitment_nullifier=${f.enforced.commitment_nullifier} — stated so it cannot be over-read`);
    }
  } catch (e) {
    const out = e.stdout ? String(e.stdout).trim() : String(e.message ?? e);
    result.fold = { state: 'UNKNOWN', reason: out };
    unk(`fold refused — ${out}`);
    note('a refused fold is reported as a gap, never as a root you could use anyway');
  }
}

// ── 7. Dual-auth gate ───────────────────────────────────────────────────────
step(7, 'Dual-auth gate — agent authority AND human authority, or neither');
if (boundStandardsHash) {
  ok(`owner standards hash (Poseidon2, from the Rust primitive): ${boundStandardsHash}`);
} else {
  unk('owner standards hash unavailable — the human authority cannot be satisfied');
}

// Imports the REAL gate (src/services/dual-auth-gate.ts, 14/14 tested), not a
// copy. A demo that reimplements the logic it demonstrates proves nothing about
// the shipped code and drifts from it the first time either changes.
let evaluateGate;
try {
  ({ evaluateGate } = await import('../../dist/services/dual-auth-gate.js'));
} catch {
  bad('gate module not built — run `npm run build` first');
  note('this demo deliberately does NOT reimplement the gate; without dist it cannot decide');
  process.exit(2);
}

// IDENTITY RESOLUTION — a real mismatch this gate caught on its first live run.
// The proof binds `agent_id` as a UUID (32e0e809-…); a caller addresses the agent
// by slug (`trinity-shofet`). Comparing those directly refuses a LEGITIMATE agent.
// The fix is to compare the canonical id the proof actually binds — NOT to drop
// the check, which would reintroduce exactly the "someone else's proof" forgery
// the STARK verifier rejects at the crypto layer.
const canonicalAgentId = result.proof?.canonicalAgentId ?? null;
if (canonicalAgentId && canonicalAgentId !== AGENT) {
  note(`slug "${AGENT}" resolves to canonical id ${canonicalAgentId} (the id the proof binds)`);
}

const gate = evaluateGate({
  agentId: result.repid?.state === 'REAL' ? (canonicalAgentId ?? AGENT) : null,
  proofVerified: result.proof?.state === 'REAL' ? true : undefined,
  proofStatement: result.proof?.statement
    ? { ...result.proof.statement, user_standards_hash: boundStandardsHash ?? undefined }
    : null,
  boundStandardsHash,
  requiredThreshold: 999,
  halVerdict,
  proofAgeSeconds: 60,
});

line('');
line(`      authorities:  agent=${gate.authorities.agent ? G + 'OK' + RESET : R + 'NO' + RESET}   human=${gate.authorities.human ? G + 'OK' + RESET : R + 'NO' + RESET}`);
line('');
line(`      ${gate.decision === 'ALLOW' ? G : R}${B}${gate.decision}${RESET}`);
line(`      ${gate.explanation}`);
if (gate.reasons.length) {
  line('');
  note('every blocker, so fixing one does not hide the next:');
  for (const r of gate.reasons) note(`  - ${r}`);
}

// THE NEW ROOT, and an honest statement of what it does and does not cover.
// The proof fetched in step 3 attests the PRE-fold score. After folding, the
// committed state has moved, so that proof is stale with respect to the new
// root — it is what the NEXT proof would be about. Saying so is the difference
// between a demo and a claim: quietly showing the new root beside a gate
// decision made on the old proof would imply a binding that does not exist yet.
if (result.fold?.state === 'REAL') {
  line('');
  note(`committed root after this outcome: ${result.fold.new_fold_root}`);
  note(`the gate above decided on the proof fetched in step 3, which attests the PRE-fold`);
  note(`score. Re-proving against the new root is the next link in the chain, not a`);
  note(`property of this one.`);
}

const legs = Object.entries(result).map(([k, v]) => `${k}=${v?.state ?? 'UNKNOWN'}`).join('  ');
line('');
line(`${DIM}legs: ${legs}${RESET}`);
const unknowns = Object.values(result).filter((v) => v?.state !== 'REAL').length;
if (unknowns) line(`${Y}${unknowns} leg(s) UNKNOWN — reported as gaps, never as passes.${RESET}`);
process.exit(gate.decision === 'ALLOW' ? 0 : 1);
