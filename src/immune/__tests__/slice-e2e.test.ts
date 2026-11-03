/**
 * slice-e2e.test.ts — the Agent Immune System slice, end to end, WITHOUT Docker.
 *
 * It synthesises the promoted-artifact bundle a sandboxed Maker + promotion gate would produce (the verdict
 * file, its sha256, a well-formed sandbox receipt with airlock_decision 'promote'), runs the trusted settler,
 * and asserts the whole flow:
 *   - the claim the stub Maker gets right  → result correct,   settlement success, combined receipt verifies;
 *   - the claim the stub Maker gets wrong  → result incorrect, settlement failure (a LEGITIMATE negative),
 *                                            combined receipt still verifies;
 *   - REFUSALS: a failure re-labelled a success is refused (incorrect_claimed_success); a component re-signed
 *     by a rogue key is refused (sandbox_untrusted_signer); a bundle that was not promoted, or whose bytes do
 *     not match their claimed hash, is refused before any receipt is built.
 *
 * Keys are four throwaway Ed25519 keypairs generated in-process — the settler's "keys are parameters, no env
 * secret" contract, exercised as production would use it. The Docker sandbox + two-job CI (immune-slice.yml)
 * can only be verified by the CI run after push; this test covers the trusted-settler core Docker-free.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { signComponentAttestation, verifyCombinedReceipt, SANDBOX_ATTESTATION_DOMAIN } from '../combined-receipt';
import {
  runTrustedSettlement,
  fixtureOracle,
  trustRootsFor,
  type OracleClaim,
  type SliceSandboxReceipt,
  type PromotedBundle,
  type SettlementKeys,
  type TrustedSettlementContext,
} from '../trusted-settler';

const allClaims = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claims.json'), 'utf8')) as OracleClaim[];
const oracle = fixtureOracle(allClaims);
const trueClaim = allClaims.find((c) => c.id === 'arith-sum-true')!;
const falseClaim = allClaims.find((c) => c.id === 'arith-sum-false')!;

/** The stub Maker's rule, mirrored from src/immune/fixtures/maker.mjs (canonical copy): affirm any '+' claim as TRUE. */
const makerVerdict = (claim: string): 'TRUE' | 'FALSE' => (claim.includes('+') ? 'TRUE' : 'FALSE');

const newKeys = (): SettlementKeys => {
  const k = () => generateKeyPairSync('ed25519').privateKey;
  return { harness: k(), evaluation: k(), settlement: k(), composite: k() };
};

const ctx = (claim: OracleClaim): TrustedSettlementContext => ({
  experiment_id: `immune-slice-${claim.id}`,
  claim_id: claim.id,
  maker_id: 'agent-maker-stub',
  maker_controller: 'controller-slice',
  checker_id: 'oracle-fixture',
  checker_controller: 'controller-slice',
});

/** Synthesise the bundle the sandbox + promotion gate would have produced for `claim`. */
function bundleFor(claim: OracleClaim, over: Partial<SliceSandboxReceipt> = {}): PromotedBundle {
  const verdict = JSON.stringify({ id: claim.id, verdict: makerVerdict(claim.claim) });
  const sha = '0x' + createHash('sha256').update(verdict, 'utf8').digest('hex');
  return {
    verdict,
    verdict_sha256: sha,
    sandbox_receipt: {
      mission_id: `mission-${claim.id}`,
      airlock_decision: 'promote',
      artifact_sha256: sha,
      profile_checks: [
        { name: 'seccomp', passed: true },
        { name: 'network_egress_blocked', passed: true },
      ],
      ...over,
    },
  };
}

describe('agent immune system slice — sandboxed maker → trusted settler → combined receipt', () => {
  it('the fixture lands exactly one correct and one incorrect across the two claims', () => {
    expect(makerVerdict(trueClaim.claim)).toBe(trueClaim.expected); // right on the true sum
    expect(makerVerdict(falseClaim.claim)).not.toBe(falseClaim.expected); // wrong on the false sum
  });

  it('the claim the Maker gets right → correct / success, and the combined receipt verifies', () => {
    const keys = newKeys();
    const res = runTrustedSettlement({ bundle: bundleFor(trueClaim), oracle, keys, context: ctx(trueClaim) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.result).toBe('correct');
    expect(res.receipt.settlement_outcome).toBe('success');
    expect(res.receipt.mode).toBe('shadow');
    expect(res.receipt.independence_class).toBe('same_controller_measured');
    expect(res.settlement.delta_sign).toBe('positive');
    expect(res.measurements.maker_tokens).toBeNull();
    expect(res.verification).toEqual({ ok: true, reasons: [], authoritative: false });
  });

  it('the claim the Maker gets wrong → incorrect / failure (legitimate negative), and the receipt still verifies', () => {
    const keys = newKeys();
    const res = runTrustedSettlement({ bundle: bundleFor(falseClaim), oracle, keys, context: ctx(falseClaim) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.result).toBe('incorrect');
    expect(res.receipt.settlement_outcome).toBe('failure');
    expect(res.settlement.delta_sign).toBe('negative');
    expect(res.verification).toEqual({ ok: true, reasons: [], authoritative: false });
  });

  it('REFUSAL (a): the failure re-labelled a success is refused incorrect_claimed_success', () => {
    const keys = newKeys();
    const res = runTrustedSettlement({ bundle: bundleFor(falseClaim), oracle, keys, context: ctx(falseClaim) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const forged = { ...res.receipt, settlement_outcome: 'success' as const };
    const v = verifyCombinedReceipt(forged, trustRootsFor(keys));
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('incorrect_claimed_success');
  });

  it('REFUSAL (b): a sandbox_attestation re-signed by a rogue key is refused sandbox_untrusted_signer', () => {
    const keys = newKeys();
    const res = runTrustedSettlement({ bundle: bundleFor(trueClaim), oracle, keys, context: ctx(trueClaim) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rogue = generateKeyPairSync('ed25519').privateKey;
    const forged = {
      ...res.receipt,
      sandbox_attestation: signComponentAttestation(SANDBOX_ATTESTATION_DOMAIN, res.receipt.sandbox_attestation.payload, rogue),
    };
    const v = verifyCombinedReceipt(forged, trustRootsFor(keys));
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('sandbox_untrusted_signer');
  });

  it('REFUSAL (c): a bundle the sandbox did not promote is refused before any receipt is built', () => {
    const res = runTrustedSettlement({ bundle: bundleFor(trueClaim, { airlock_decision: 'refuse' }), oracle, keys: newKeys(), context: ctx(trueClaim) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('sandbox_not_promoted');
  });

  it('REFUSAL (d): a verdict whose bytes do not match their claimed sha256 is refused (data-only integrity)', () => {
    const b = bundleFor(trueClaim);
    const tampered: PromotedBundle = { ...b, verdict: b.verdict + ' ' }; // bytes changed, claimed sha now stale
    const res = runTrustedSettlement({ bundle: tampered, oracle, keys: newKeys(), context: ctx(trueClaim) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('verdict_sha_mismatch');
  });

  it('BINDING (Strix CWE-807): a verdict naming a DIFFERENT claim than the one ISSUED is never scored (not_scorable)', () => {
    // Issued the TRUE claim, but the Maker answers naming the FALSE claim — it must not pick its own answer key.
    const verdict = JSON.stringify({ id: falseClaim.id, verdict: 'TRUE' });
    const sha = '0x' + createHash('sha256').update(verdict, 'utf8').digest('hex');
    const bundle: PromotedBundle = {
      verdict,
      verdict_sha256: sha,
      sandbox_receipt: { mission_id: 'mission-x', airlock_decision: 'promote', artifact_sha256: sha, profile_checks: [{ name: 'seccomp', passed: true }] },
    };
    const res = runTrustedSettlement({ bundle, oracle, keys: newKeys(), context: ctx(trueClaim) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.result).toBe('not_scorable');
    expect(res.receipt.settlement_outcome).toBe('none');
    expect(res.settlement.delta_sign).toBe('none');
    expect(res.verification).toEqual({ ok: true, reasons: [], authoritative: false });
  });

  it('CONTAINMENT (Strix CWE-636): a promoted bundle with a FAILED containment check is refused, never settled', () => {
    const res = runTrustedSettlement({
      bundle: bundleFor(trueClaim, { profile_checks: [{ name: 'seccomp', passed: true }, { name: 'container_destroyed', passed: false }] }),
      oracle,
      keys: newKeys(),
      context: ctx(trueClaim),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('containment_not_established');
  });

  it('CONTAINMENT (required-check allowlist, Grok red-team): a bundle missing a REQUIRED check is refused even when its own checks all passed', () => {
    // The bundle's own checks (seccomp, network_egress_blocked) all pass, but the run REQUIRES container_destroyed,
    // which the bundle never recorded — "some check passed" must not be enough.
    const res = runTrustedSettlement({
      bundle: bundleFor(trueClaim),
      oracle,
      keys: newKeys(),
      context: { ...ctx(trueClaim), required_checks: ['seccomp', 'container_destroyed'] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('containment_not_established');
  });

  it('CONTAINMENT: a promoted bundle recording NO containment checks is refused (cannot attest what it never observed)', () => {
    const res = runTrustedSettlement({
      bundle: bundleFor(trueClaim, { profile_checks: [] }),
      oracle,
      keys: newKeys(),
      context: ctx(trueClaim),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('containment_not_established');
  });

  it('BINDING: a sandbox that recorded a DIFFERENT artifact sha than the promoted bytes is refused (real bind, not tautology)', () => {
    const res = runTrustedSettlement({
      bundle: bundleFor(trueClaim, { artifact_sha256: '0x' + 'ab'.repeat(32) }), // sandbox "recorded" a sha ≠ our bytes
      oracle,
      keys: newKeys(),
      context: ctx(trueClaim),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refused).toContain('sandbox_artifact_mismatch');
  });
});
