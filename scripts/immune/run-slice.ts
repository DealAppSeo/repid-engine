/**
 * scripts/immune/run-slice.ts — the TRUSTED settlement runner for the Agent Immune System slice (Job B).
 *
 * It runs with the repid-engine's OWN checked-out code (not the maker artifact). It reads the downloaded
 * maker bundles as DATA ONLY — parse JSON, hash bytes — and NEVER executes, evals, sources or imports
 * anything from them. For each promoted verdict it:
 *   1. adapts the TrustShell sandbox-mission receipt into the slice's minimal SliceSandboxReceipt shape;
 *   2. generates four throwaway Ed25519 keys in-job (harness / evaluation / settlement / composite);
 *   3. calls runTrustedSettlement → validate, score against the committed fixture oracle, DRY-RUN settle,
 *      emit the combined receipt (#1494) and re-verify it independently;
 * then it runs the two refusal demos (a failure re-labelled a success; a component re-signed by a rogue key),
 * writes every receipt + the refusal result + the measurements + the sandbox provenance to --out, and EXITS
 * NON-ZERO if any expected-ok receipt fails to verify or any expected-refusal verifies.
 *
 * TRUST BOUNDARY NOTE. `settle` and `maker` are separate CI jobs, which is NOT automatically a trust boundary:
 * this runner treats the maker output as DATA only and shares no mutable cache with it. HONEST LIMIT: on a
 * `pull_request` event the settle job checks out the PR merge ref, so this code is the PR's OWN version, not a
 * protected base ref — the boundary holds only because the job carries no secret. The bundle's TrustShell harness
 * PUBLIC key is recorded as provenance; binding and VERIFYING the sandbox receipt's own harness signature (so the
 * settler carries it rather than re-deriving facts) is the next Sean-gated gate — see sandbox-provenance.json.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { signComponentAttestation, verifyCombinedReceipt, SANDBOX_ATTESTATION_DOMAIN } from '../../src/immune/combined-receipt';
import {
  runTrustedSettlement,
  fixtureOracle,
  trustRootsFor,
  type OracleClaim,
  type SliceSandboxReceipt,
  type SettlementKeys,
} from '../../src/immune/trusted-settler';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const readJsonMaybe = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
};
const newKeys = (): SettlementKeys => {
  const k = (): KeyObject => generateKeyPairSync('ed25519').privateKey;
  return { harness: k(), evaluation: k(), settlement: k(), composite: k() };
};

/**
 * DATA-ONLY adaptation of the TrustShell sandbox-mission receipt + promote output into the slice's shape.
 * FAIL-CLOSED: every containment fact is derived from the REAL receipt (`receipt.profile.checks` / `worker` /
 * `destroy` / mounts); a missing receipt or a missing/failed fact yields a NOT-promoted, not-contained shape the
 * settler refuses. The bound artifact sha is the one the SANDBOX recorded (airlock / promoted), never a recompute
 * of our own bytes — so the settler's cross-check is a real binding, not a tautology. (Verifying the receipt's own
 * harness signature is the next Sean-gated gate; the harness public key is carried as provenance.)
 */
function adaptSandboxReceipt(dir: string, verdict: string, claimId: string): { sr: SliceSandboxReceipt; harnessPubKey: unknown } {
  const envelope = readJsonMaybe(join(dir, 'receipt.json')); // { receipt, signature } — trustshell.sandbox-mission-receipt/v2
  const rc = envelope?.receipt; // the signed receipt body
  const promoteJson = readJsonMaybe(join(dir, 'promote.json')); // `trustshell sandbox promote --json`
  const keysJson = readJsonMaybe(join(dir, 'public-keys.json'));

  // the sha the SANDBOX independently recorded for the promoted verdict file (not our recompute of the bytes).
  const recordedIn = (xs: unknown): string | undefined =>
    Array.isArray(xs) ? (xs.find((a: any) => a?.name === 'verdict.json' && typeof a?.sha256 === 'string') as any)?.sha256 : undefined;
  const recordedSha = recordedIn(rc?.artifacts?.promoted) ?? recordedIn(rc?.airlock?.inspected) ?? recordedIn(promoteJson?.promoted);

  const checks: any[] = Array.isArray(rc?.profile?.checks) ? rc.profile.checks : [];
  const inputMount = Array.isArray(rc?.profile?.observed?.Mounts)
    ? rc.profile.observed.Mounts.find((m: any) => m?.Destination === '/mission/input')
    : undefined;
  const profile_checks: SliceSandboxReceipt['profile_checks'] = [
    { name: 'restriction_profile_read_back', passed: checks.length > 0 && checks.every((c: any) => c?.ok === true), detail: `${checks.length} docker-inspect checks` },
    { name: 'worker_executed', passed: rc?.worker?.exit_code === 0 && rc?.worker?.timed_out === false && rc?.worker?.oom_killed === false },
    { name: 'input_mounted_read_only', passed: inputMount?.RW === false },
    { name: 'container_destroyed', passed: rc?.destroy?.container_removed === true },
    { name: 'promotion_self_verified', passed: promoteJson?.verify?.ok === true },
  ];
  // promoted only when a real receipt recorded THIS artifact AND the promotion writer self-verified.
  const promoted =
    rc != null &&
    typeof recordedSha === 'string' &&
    promoteJson?.verify?.ok === true &&
    Array.isArray(promoteJson?.promoted) &&
    promoteJson.promoted.some((a: any) => a?.name === 'verdict.json');

  return {
    sr: {
      mission_id: String(rc?.mission_id ?? `mission-${claimId}`),
      airlock_decision: promoted ? 'promote' : 'refuse',
      artifact_sha256: typeof recordedSha === 'string' ? recordedSha : 'unrecorded',
      profile_checks,
    },
    harnessPubKey: keysJson?.harness ?? rc?.keys?.harness ?? null,
  };
}

function main(): void {
  const bundlesDir = arg('--bundles', '');
  const outDir = arg('--out', '');
  if (!bundlesDir || !outDir) {
    console.error('usage: run-slice.ts --bundles <dir> --out <dir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const claimsPath = join(__dirname, '..', '..', 'src', 'immune', 'fixtures', 'claims.json');
  const oracle = fixtureOracle(JSON.parse(readFileSync(claimsPath, 'utf8')) as OracleClaim[]);

  // DATA-ONLY discovery: every verdict.json under the download dir is one promoted bundle.
  const verdictFiles = readdirSync(bundlesDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => basename(f) === 'verdict.json')
    .map((f) => join(bundlesDir, f));
  if (verdictFiles.length === 0) {
    console.error(`[run-slice] no verdict.json found under ${bundlesDir}`);
    process.exit(1);
  }

  const summary: Record<string, unknown>[] = [];
  const provenance: Record<string, unknown>[] = [];
  const measurements: Record<string, unknown>[] = [];
  let failures = 0;
  let okReceiptKeys: SettlementKeys | null = null;
  let okFalseReceipt: unknown = null; // an incorrect-result receipt, for refusal demo (a)
  let okTrueReceipt: unknown = null; // a correct-result receipt, for refusal demo (b)

  for (const vf of verdictFiles) {
    const dir = dirname(vf);
    const verdict = readFileSync(vf, 'utf8');
    // `tag` is unique per bundle (its path under the download dir), so the 2×2 CI matrix never collides a
    // per-receipt filename or experiment_id.
    const tag = relative(bundlesDir, dir).replace(/[^A-Za-z0-9._-]+/g, '_') || basename(dir);
    // The claim this bundle was ISSUED, resolved from its published bundle NAME against the committed claim set —
    // never from the verdict's own contents (the Maker must not pick which claim it is graded on; Strix CWE-807).
    const issued = oracle.claims.filter((c) => tag.includes(c.id));
    const issuedClaim = issued.length === 1 ? issued[0] : undefined;
    if (!issuedClaim) {
      console.error(`[run-slice] ${tag}: bundle name does not identify exactly one oracle claim — not scored`);
      summary.push({ bundle: tag, ok: false, refused: ['unidentified_issued_claim'] });
      failures++;
      continue;
    }
    const id = issuedClaim.id;
    const { sr, harnessPubKey } = adaptSandboxReceipt(dir, verdict, id);
    provenance.push({ bundle: tag, claim: id, trustshell_harness_public_key: harnessPubKey, note: 'carried as provenance; harness-signature carry-through is the next Sean-gated gate' });

    const keys = newKeys();
    const res = runTrustedSettlement({
      bundle: { verdict, verdict_sha256: '0x' + sha256hex(verdict), sandbox_receipt: sr },
      oracle,
      keys,
      context: {
        experiment_id: `immune-slice-${tag}`,
        claim_id: id,
        maker_id: 'agent-maker-stub',
        maker_controller: 'controller-slice',
        checker_id: 'oracle-fixture',
        checker_controller: 'controller-slice',
      },
    });

    if (!res.ok) {
      console.error(`[run-slice] ${tag}: bundle REFUSED before settlement: ${res.refused.join(', ')}`);
      summary.push({ bundle: tag, ok: false, refused: res.refused });
      failures++; // in CI every downloaded bundle was genuinely promoted, so a refusal here is a real failure
      continue;
    }
    writeFileSync(join(outDir, `combined-receipt-${tag}.json`), JSON.stringify({ receipt: res.receipt, verification: res.verification, settlement: res.settlement }, null, 2) + '\n');
    measurements.push({ bundle: tag, claim: id, ...res.measurements, result: res.receipt.result, settlement_outcome: res.receipt.settlement_outcome });
    summary.push({ bundle: tag, claim: id, ok: true, result: res.receipt.result, settlement_outcome: res.receipt.settlement_outcome, verification_ok: res.verification.ok, delta_sign: res.settlement.delta_sign });
    if (!res.verification.ok) {
      console.error(`[run-slice] ${tag}: EXPECTED-OK receipt FAILED to verify: ${res.verification.reasons.join(', ')}`);
      failures++;
      continue;
    }
    console.log(`[run-slice] ${tag}: ${res.receipt.result} / ${res.receipt.settlement_outcome} — combined receipt verifies`);
    okReceiptKeys = keys;
    if (res.receipt.result === 'incorrect') okFalseReceipt = res.receipt;
    if (res.receipt.result === 'correct') okTrueReceipt = res.receipt;
  }

  // Refusal demos: the same flow must REFUSE a dishonest / forged result. Needs the keys of an ok receipt.
  const refusal: Record<string, unknown> = {};
  if (okReceiptKeys) {
    const roots = trustRootsFor(okReceiptKeys);
    // (a) a failure re-labelled a success.
    if (okFalseReceipt && typeof okFalseReceipt === 'object') {
      const forged = { ...(okFalseReceipt as Record<string, unknown>), settlement_outcome: 'success' };
      const v = verifyCombinedReceipt(forged, roots);
      refusal['incorrect_claimed_success'] = v;
      if (v.ok || !v.reasons.includes('incorrect_claimed_success')) {
        console.error('[run-slice] refusal demo (a) did NOT refuse incorrect_claimed_success');
        failures++;
      } else console.log('[run-slice] refusal (a): incorrect→success refused:', v.reasons.join(', '));
    }
    // (b) a component re-signed by a rogue key not in the trust roots.
    if (okTrueReceipt && typeof okTrueReceipt === 'object') {
      const r = okTrueReceipt as { sandbox_attestation: { payload: unknown } };
      const rogue = generateKeyPairSync('ed25519').privateKey;
      const forged = { ...(okTrueReceipt as Record<string, unknown>), sandbox_attestation: signComponentAttestation(SANDBOX_ATTESTATION_DOMAIN, r.sandbox_attestation.payload, rogue) };
      const v = verifyCombinedReceipt(forged, roots);
      refusal['sandbox_untrusted_signer'] = v;
      if (v.ok || !v.reasons.includes('sandbox_untrusted_signer')) {
        console.error('[run-slice] refusal demo (b) did NOT refuse sandbox_untrusted_signer');
        failures++;
      } else console.log('[run-slice] refusal (b): rogue-signed sandbox attestation refused:', v.reasons.join(', '));
    }
  } else {
    console.error('[run-slice] no ok receipt available to run the refusal demos');
    failures++;
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(outDir, 'refusal-demo.json'), JSON.stringify(refusal, null, 2) + '\n');
  writeFileSync(join(outDir, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n');
  writeFileSync(join(outDir, 'sandbox-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

  console.log(`[run-slice] ${summary.length} bundle(s), ${failures} failure(s). out: ${outDir}`);
  if (failures > 0) process.exit(1);
}

main();
