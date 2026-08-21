/**
 * live-prover-crosscheck.ts — the ONE measurement the ZKP path is missing.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS ALREADY MEASURED, SO THIS DOES NOT REDO IT
 * ════════════════════════════════════════════════════════════════════════════════
 * `tests/zkp-proof-verifier-crosscheck.test.ts` already runs a GENUINE Plonky3
 * range-check proof through the REAL `@hyperdag/proof-verifier` WASM and asserts the
 * whole accept/reject matrix — honest accepts; inflated score, substituted agent_id,
 * lowered threshold and score-at-or-below-threshold all reject. That is in CI and it
 * passes.
 *
 * But that proof comes from the VERIFIER CRATE'S OWN prover, generated offline
 * (`scripts/zkp/gen-synthetic-rangecheck-proof.rs`). So what CI proves is:
 * "the crate can verify what the crate produced."
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ════════════════════════════════════════════════════════════════════════════════
 * Nothing has ever checked that the DEPLOYED `zkp-postcard` prover's output verifies
 * under the published verifier. Both are aggregation-tier and both are supposed to sit
 * at Plonky3 git rev `27d59f7350` (CANON P-026 lockstep) — but `docs/zkp/
 * PLONKY3_PIN_RECONCILIATION.md` documents a live Invariant-5 divergence (two pins on
 * two mechanisms), and "supposed to" is not a measurement. A pin drift on either side
 * shows up here as a rejected honest proof and nowhere else.
 *
 * Until this runs green, the honest status of the end-to-end ZKP path is NOT_CHECKED —
 * not FAILED, and emphatically not MEASURED.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A SCRIPT AND NOT A TEST
 * ════════════════════════════════════════════════════════════════════════════════
 * It needs network egress to `zkp-postcard`, which the agent sandbox denies (CONNECT
 * 403) and which CI should not depend on either — a gate that reddens for environmental
 * reasons gets ignored within a week, at which point it is worse than no gate. Run it
 * deliberately from somewhere the prover is reachable.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE #376 FENCE — READ BEFORE CHANGING THE WITNESS
 * ════════════════════════════════════════════════════════════════════════════════
 * PR #376 put a proof lifted from the production `repid_zkp_proofs` table — real agent
 * UUID, real score — into this PUBLIC repo. That cannot be withdrawn, and
 * `scripts/hooks/prod-fixture-guard.js` now blocks the shape permanently.
 *
 * So this script asks the live prover for a proof over a FABRICATED witness: a
 * NIL-variant UUID that cannot collide with a real agent, and a made-up score. It is a
 * real proof from the real service over inputs that never existed in production.
 *
 * It NEVER writes the proof to disk and NEVER prints proof bytes. The observation is
 * the accept/reject matrix, not the artifact.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   ZKP_SERVICE_URL=https://<prover-host> npx ts-node scripts/zkp/live-prover-crosscheck.ts
 *   … --score 4200 --threshold 1000     # override the fabricated witness
 *   … --timeout 30000                   # prover can be slow on a cold start
 *
 * EXIT CODES — three outcomes, never two:
 *   0  VERIFIED    — live proof accepted, and every mutation rejected.
 *   2  NOT_CHECKED — no URL, prover unreachable, or prover returned no proof. This is
 *                    an ABSENCE of evidence about the ZKP path, not evidence against it.
 *   1  FAILED      — the live proof did NOT verify, or a mutation was ACCEPTED. Either
 *                    is a real finding: the first suggests pin drift, the second is far
 *                    worse and means the statement is not binding what it claims to.
 */

import { createRequire } from 'node:module';

const require_ = createRequire(__filename);

/** The package's Node WASM target — the identical entry point the passing CI crosscheck uses. */
const verifier: { init_panic_hook(): void; verify_proof(inputJson: string): string } =
  require_('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js');

interface Statement {
  agent_id: string;
  tier: string;
  repid_score: number;
  threshold: number;
}

interface VerifyResult {
  verified: boolean;
  error: string | null;
  proof_size_bytes: number;
  verifier_version: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * FABRICATED witness. The UUID is a NIL-variant address that no real agent can hold, so
 * this can never become a production extract. Do not replace it with a live agent id —
 * see the #376 fence in the header.
 */
const SYNTHETIC_AGENT_ID = '00000000-0000-4000-8000-0000000000bb';
const SCORE = Number(arg('score') ?? 4200);
const THRESHOLD = Number(arg('threshold') ?? 1000);
const TIMEOUT_MS = Number(arg('timeout') ?? 30_000);

/**
 * Fail-closed verify boundary, mirroring `createWasmVerifier` in
 * `src/services/handlers/zkp-audit-handler.ts`. Any throw or unexpected shape resolves
 * to `verified: false`. A verifier that cannot run must NEVER read as "verified" — the
 * dangerous default is the silent true, and this repo has already shipped that bug once
 * (`!!someObject` is always true; see tests/verify-proof-fail-closed.test.ts).
 */
function verifyFailClosed(proofB64: string, statement: Statement): VerifyResult {
  const fail = (error: string): VerifyResult => ({
    verified: false,
    error,
    proof_size_bytes: 0,
    verifier_version: 'unknown',
  });
  let raw: unknown;
  try {
    raw = JSON.parse(verifier.verify_proof(JSON.stringify({ proof_bytes: proofB64, statement })));
  } catch (e) {
    return fail(`verifier unavailable: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as VerifyResult).verified !== 'boolean') {
    return fail('verifier returned an unexpected shape');
  }
  return raw as VerifyResult;
}

/** Ask the live prover for a proof over the fabricated witness. */
async function requestLiveProof(url: string): Promise<{ proofB64: string } | { notChecked: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/zkp/repid-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: SYNTHETIC_AGENT_ID,
        score: SCORE,
        metadata: { source: 'live-prover-crosscheck', synthetic: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { notChecked: `prover returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    // Accept the field names the service is known to use; report rather than guess if absent.
    const proofB64 =
      (body.proof_bytes as string) ?? (body.proof as string) ?? (body.proof_b64 as string);
    if (typeof proofB64 !== 'string' || proofB64.length === 0) {
      return {
        notChecked:
          'prover responded 200 but carried no proof bytes. Keys present: ' +
          Object.keys(body).join(', ') +
          '. That is a contract mismatch to report, not a verification failure.',
      };
    }
    return { proofB64 };
  } catch (e) {
    const msg = (e as Error).message;
    return { notChecked: `could not reach the prover: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The mutations. Each changes exactly ONE bound public value, so a rejection localises
 * which binding held. The CI crosscheck pins these same four against the crate's own
 * prover; running them against the LIVE prover's proof is what makes the end-to-end
 * claim rather than the crate-internal one.
 */
function mutations(honest: Statement): { label: string; statement: Statement }[] {
  return [
    { label: 'inflated score', statement: { ...honest, repid_score: honest.repid_score + 1000 } },
    {
      label: 'substituted agent_id',
      statement: { ...honest, agent_id: '00000000-0000-4000-8000-0000000000cc' },
    },
    { label: 'lowered threshold', statement: { ...honest, threshold: Math.max(0, honest.threshold - 500) } },
    {
      label: 'score at/below its own threshold',
      statement: { ...honest, repid_score: honest.threshold },
    },
  ];
}

async function main(): Promise<number> {
  const url = process.env.ZKP_SERVICE_URL || process.env.PLONKY3_PROVER_URL || '';
  console.log('=== LIVE PROVER → PUBLISHED VERIFIER CROSSCHECK ===\n');

  if (!url) {
    console.log('NOT_CHECKED — set ZKP_SERVICE_URL (or PLONKY3_PROVER_URL) to the prover host.');
    console.log('This says nothing about the ZKP path. It means we did not look.');
    return 2;
  }

  console.log(`prover     : ${url.replace(/\/+$/, '')}/zkp/repid-proof`);
  console.log(`witness    : SYNTHETIC agent ${SYNTHETIC_AGENT_ID}, score ${SCORE}, threshold ${THRESHOLD}`);
  console.log('             (fabricated — never a production agent; see the #376 fence)\n');

  verifier.init_panic_hook();

  const got = await requestLiveProof(url);
  if ('notChecked' in got) {
    console.log(`NOT_CHECKED — ${got.notChecked}`);
    console.log('\nAn unreachable or contract-mismatched prover is an ABSENCE of observation.');
    console.log('It is not evidence that the ZKP path is broken, and must not be reported as such.');
    return 2;
  }

  const honest: Statement = {
    agent_id: SYNTHETIC_AGENT_ID,
    tier: 'ESTABLISHED',
    repid_score: SCORE,
    threshold: THRESHOLD,
  };

  let failed = false;

  // 1. The honest statement must verify.
  const ok = verifyFailClosed(got.proofB64, honest);
  console.log(
    `  ${ok.verified ? 'ACCEPT ✓' : 'REJECT ✗'}  honest statement` +
      `   [verifier ${ok.verifier_version}, ${ok.proof_size_bytes} bytes]`,
  );
  if (!ok.verified) {
    console.log(`           error: ${ok.error}`);
    console.log(
      '\n  ^ A proof from the LIVE prover did not verify under the PUBLISHED verifier.\n' +
        '    Most likely a Plonky3 pin divergence between the two tiers — see\n' +
        '    docs/zkp/PLONKY3_PIN_RECONCILIATION.md (Invariant 5). Report the verifier\n' +
        '    version and this error; do NOT "fix" it by relaxing the verifier.',
    );
    failed = true;
  }

  // 2. Every mutation must be rejected. An ACCEPTED mutation is the serious finding.
  for (const m of mutations(honest)) {
    const r = verifyFailClosed(got.proofB64, m.statement);
    console.log(`  ${r.verified ? 'ACCEPT ✗' : 'REJECT ✓'}  ${m.label}`);
    if (r.verified) {
      console.log(
        `\n  ^ SERIOUS: the verifier ACCEPTED a mutated statement (${m.label}).\n` +
          '    That means the value is not actually bound by the STARK, and any\n' +
          '    downstream claim resting on it is unsound. Stop and escalate.',
      );
      failed = true;
    }
  }

  if (failed) {
    console.log('\nFAILED — see above. This is a real finding, not a flake; do not re-run for a green.');
    return 1;
  }

  console.log(
    '\nVERIFIED — a proof from the LIVE prover verified under the PUBLISHED verifier,\n' +
      'and all four single-value mutations were rejected. The end-to-end prove→verify\n' +
      'link is MEASURED for this statement (A1 range-check).\n\n' +
      'WHAT THIS DOES NOT ESTABLISH, and must not be reported as: that the product path\n' +
      'fails closed without a proof (separate — tests/verify-proof-fail-closed.test.ts),\n' +
      'that any UI may drop its "not live yet" label (needs a GateRun, not a script run),\n' +
      'or anything about the leaf tier, which is a different circuit at a different pin.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`FAILED — unexpected: ${(e as Error).message}`);
    process.exit(1);
  });
