/**
 * Mission 1 test #7: the canonical receipt envelope renders the SIX claims separately, with
 * evidence gaps and a "what this does not establish" line — never one green badge.
 *
 * The six claims — Integrity, Authenticity, Observation, Correctness, Authorization, Containment —
 * each carry their own status. A claim with insufficient evidence is NOT_CHECKED and NEVER renders
 * as VERIFIED. There is no top-level boolean rollup. The envelope is an in-toto Statement over the
 * receipt, so a stranger can verify it with standard tooling.
 */
import { runUnderKernel } from '../gate';
import type { KernelReceipt } from '../types';
import { harness, iso, signedPolicy, spendRequest } from './fixtures';
import {
  toSixClaimStatement,
  SIX_CLAIM_KEYS,
  SIX_CLAIMS_PREDICATE_TYPE,
  type ClaimStatus,
} from '../six-claims';

async function denyReceipt(): Promise<KernelReceipt> {
  const h = harness();
  await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
  const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), async () => 'blocked', h.deps);
  return out.decision_receipt!;
}

async function allowSpendReceipt(): Promise<KernelReceipt> {
  const h = harness();
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
  const out = await runUnderKernel(spendRequest({ amount_raw: '10000' }), async () => 'paid', h.deps);
  return out.final_receipt!;
}

describe('(1) in-toto Statement shape, with the six claims and no collapsed badge', () => {
  let stmt: ReturnType<typeof toSixClaimStatement>;
  let receipt: KernelReceipt;
  beforeAll(async () => {
    receipt = await denyReceipt();
    stmt = toSixClaimStatement(receipt);
  });

  it('is an in-toto Statement over the receipt as subject', () => {
    expect(stmt._type).toBe('https://in-toto.io/Statement/v1');
    expect(stmt.predicateType).toBe(SIX_CLAIMS_PREDICATE_TYPE);
    expect(stmt.subject).toHaveLength(1);
    expect(stmt.subject[0]!.name).toBe(`kernel-receipt:${receipt.header.receipt_id}`);
    // the subject digest is the receipt's own keccak256 receipt_hash, named honestly
    expect(stmt.subject[0]!.digest.keccak256).toBe(receipt.header.receipt_hash.replace(/^0x/, ''));
  });

  it('states all six claims separately, each with a status/statement/supports/gaps', () => {
    for (const key of SIX_CLAIM_KEYS) {
      const c = stmt.predicate.claims[key];
      expect(c).toBeDefined();
      expect(['VERIFIED', 'NOT_CHECKED', 'FAILED', 'NOT_APPLICABLE']).toContain(c.status);
      expect(typeof c.statement).toBe('string');
      expect(Array.isArray(c.supports)).toBe(true);
      expect(Array.isArray(c.gaps)).toBe(true);
    }
    expect(Object.keys(stmt.predicate.claims).sort()).toEqual([...SIX_CLAIM_KEYS].sort());
  });

  it('never collapses to one green badge: no top-level boolean rollup', () => {
    expect('verified' in (stmt.predicate as object)).toBe(false);
    expect('ok' in (stmt.predicate as object)).toBe(false);
    expect('pass' in (stmt.predicate as object)).toBe(false);
    // the only summary is the six separate statuses and the gaps line
    expect(stmt.predicate.what_this_does_not_establish.length).toBeGreaterThan(0);
  });
});

describe('(2) a DENY receipt — authorization FAILED, nothing fabricated as verified', () => {
  it('maps the refusal honestly', async () => {
    const c = toSixClaimStatement(await denyReceipt()).predicate.claims;
    expect(c.authorization.status).toBe('FAILED'); // the action was refused
    expect(c.integrity.status).toBe('VERIFIED'); // the record is still whole and chained
    expect(c.authenticity.status).toBe('VERIFIED'); // owner resolved + policy signature verified
    expect(c.observation.status).toBe('NOT_APPLICABLE'); // no payment on a refusal
    expect(c.correctness.status).toBe('NOT_APPLICABLE'); // no content verification
    expect(c.containment.status).toBe('VERIFIED'); // tool never ran
  });
});

describe('(3) an ALLOW spend — authorized is NOT observed (NOT_CHECKED must not read as VERIFIED)', () => {
  it('authorization VERIFIED, but observation NOT_CHECKED because nothing settled on chain', async () => {
    const c = toSixClaimStatement(await allowSpendReceipt()).predicate.claims;
    expect(c.authorization.status).toBe('VERIFIED');
    // THE load-bearing assertion: an authorized-but-unobserved payment is NOT_CHECKED, never VERIFIED.
    expect(c.observation.status).toBe('NOT_CHECKED');
    expect(c.observation.status).not.toBe('VERIFIED');
    expect(c.observation.gaps.join(' ')).toMatch(/authorized is not observed/);
    expect(c.integrity.status).toBe('VERIFIED');
    expect(c.containment.status).toBe('VERIFIED');
  });
});

describe('(4) correctness is VERIFIED only when SETTLED — a vote alone never is', () => {
  let base: KernelReceipt;
  beforeAll(async () => { base = await denyReceipt(); });

  const withVerification = (over: Partial<KernelReceipt['verification']>): KernelReceipt =>
    ({ ...base, verification: { ...base.verification, ...over } });

  it('a holdout-SETTLED, VERIFIED verification → correctness VERIFIED', () => {
    const c = toSixClaimStatement(
      withVerification({ status: 'VERIFIED', verdict_label: 'SETTLED', settled_by: 'holdout' }),
    ).predicate.claims;
    expect(c.correctness.status).toBe('VERIFIED');
  });

  it('a PROVISIONAL vote (no settler) → correctness NOT_CHECKED, never VERIFIED', () => {
    const c = toSixClaimStatement(
      withVerification({ status: 'NOT_CHECKED', verdict_label: 'PROVISIONAL', settled_by: null }),
    ).predicate.claims;
    expect(c.correctness.status).toBe('NOT_CHECKED');
    expect(c.correctness.status).not.toBe('VERIFIED');
    expect(c.correctness.gaps.join(' ')).toMatch(/a vote alone is PROVISIONAL/);
  });

  it('even a VERIFIED status that is only PROVISIONAL does not reach correctness VERIFIED', () => {
    // defence in depth: status VERIFIED but verdict_label PROVISIONAL must still not be correctness VERIFIED
    const c = toSixClaimStatement(
      withVerification({ status: 'VERIFIED', verdict_label: 'PROVISIONAL', settled_by: null }),
    ).predicate.claims;
    expect(c.correctness.status).not.toBe('VERIFIED');
  });
});

describe('(5) observation is VERIFIED only when MEASURED on chain', () => {
  let base: KernelReceipt;
  beforeAll(async () => { base = await allowSpendReceipt(); });

  const withPayment = (over: Partial<KernelReceipt['payment']>): KernelReceipt =>
    ({ ...base, payment: { ...base.payment, ...over } });

  it('a MEASURED settled payment → observation VERIFIED', () => {
    const c = toSixClaimStatement(
      withPayment({ status: 'SETTLED', settlement_evidence: 'MEASURED', tx_hash: `0x${'a'.repeat(64)}`, observed_amount_raw: '10000', is_simulated: false }),
    ).predicate.claims;
    expect(c.observation.status).toBe('VERIFIED');
  });

  it('an authorized-only payment → observation NOT_CHECKED', () => {
    const c = toSixClaimStatement(
      withPayment({ status: 'AUTHORIZED', settlement_evidence: 'NOT_CHECKED', tx_hash: null }),
    ).predicate.claims;
    expect(c.observation.status).toBe('NOT_CHECKED');
  });
});

describe('(6) non-vacuity — a real receipt carries at least one non-VERIFIED claim', () => {
  it('the ALLOW spend is not all-green: at least one claim is NOT_CHECKED or NOT_APPLICABLE', async () => {
    const claims = toSixClaimStatement(await allowSpendReceipt()).predicate.claims;
    const statuses = SIX_CLAIM_KEYS.map((k) => claims[k].status as ClaimStatus);
    expect(statuses.some((s) => s === 'NOT_CHECKED' || s === 'NOT_APPLICABLE')).toBe(true);
  });
});
