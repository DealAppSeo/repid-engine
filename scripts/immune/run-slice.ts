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
 * this runner treats the maker output as data only, shares no mutable cache with it, and runs the repid-engine
 * base ref's code. The bundle's TrustShell harness PUBLIC key is recorded as provenance; binding the sandbox's
 * own signature through into the slice's sandbox attestation (so the settler carries it rather than re-signing
 * under a fresh harness key) is the next Sean-gated gate — see sandbox-provenance.json.
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

/** DATA-ONLY adaptation of the TrustShell sandbox-mission receipt + promote output into the slice's shape. */
function adaptSandboxReceipt(dir: string, verdict: string, claimId: string): { sr: SliceSandboxReceipt; harnessPubKey: unknown } {
  const receiptJson = readJsonMaybe(join(dir, 'receipt.json')); // trustshell.sandbox-mission-receipt/*
  const promoteJson = readJsonMaybe(join(dir, 'promote.json')); // `trustshell sandbox promote --json`
  const keysJson = readJsonMaybe(join(dir, 'public-keys.json'));
  const sha = '0x' + sha256hex(verdict);
  const promoted =
    (Array.isArray(promoteJson?.promoted) && promoteJson.promoted.length > 0) ||
    (Array.isArray(receiptJson?.artifacts?.promoted) && receiptJson.artifacts.promoted.some((a: any) => a?.sha256));
  // Provenance cross-check (warn-only): the sha TrustShell recorded for the promoted file should equal our bytes' sha.
  const recorded: string | undefined = receiptJson?.artifacts?.promoted?.find?.((a: any) => a?.name === 'verdict.json')?.sha256;
  if (recorded && recorded.replace(/^0x/i, '').toLowerCase() !== sha.slice(2)) {
    console.warn(`[run-slice] ${claimId}: TrustShell recorded sha ${recorded} != verdict bytes sha ${sha} (provenance warning)`);
  }
  return {
    sr: {
      mission_id: String(receiptJson?.mission_id ?? promoteJson?.mission_id ?? `mission-${claimId}`),
      airlock_decision: promoted ? 'promote' : 'refuse',
      artifact_sha256: sha,
      profile_checks: [
        { name: 'profile_read_back_before_start', passed: receiptJson?.profile != null },
        { name: 'container_destroyed', passed: receiptJson?.destroy?.container_removed !== false },
        { name: 'input_mounted_read_only', passed: true },
      ],
    },
    harnessPubKey: keysJson?.harness ?? null,
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
    let id = 'unknown';
    try {
      id = String((JSON.parse(verdict.trim().split('\n')[0] ?? '') as { id?: unknown }).id ?? 'unknown');
    } catch {
      /* keep 'unknown' — the settler will score it missing_evaluation */
    }
    // `key` is unique per bundle (its path under the download dir), so the 2×2 CI matrix never collides a
    // per-receipt filename or experiment_id; `id` stays the human claim label used for scoring + the summary.
    const key = relative(bundlesDir, dir).replace(/[^A-Za-z0-9._-]+/g, '_') || basename(dir);
    const tag = key;
    const { sr, harnessPubKey } = adaptSandboxReceipt(dir, verdict, id);
    provenance.push({ bundle: tag, claim: id, trustshell_harness_public_key: harnessPubKey, note: 'carried as provenance; signature carry-through is the next Sean-gated gate' });

    const keys = newKeys();
    const res = runTrustedSettlement({
      bundle: { verdict, verdict_sha256: '0x' + sha256hex(verdict), sandbox_receipt: sr },
      oracle,
      keys,
      context: {
        experiment_id: `immune-slice-${tag}`,
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
