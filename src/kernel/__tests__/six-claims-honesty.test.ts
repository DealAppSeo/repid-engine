/**
 * The six-claim wording, held to what is actually checked (gap matrix 2026-10-31):
 *   · Integrity was VERIFIED from the hash's SHAPE alone and said "chained" from one receipt. It now
 *     recomputes the hash: a receipt edited after hashing FAILS.
 *   · Authorization said "under a signed owner policy" even when the signature was not verified.
 *   · Containment said "the execution boundary held"; what is checked is executed ⇒ ALLOW.
 */
import { runUnderKernel } from '../gate';
import type { KernelReceipt } from '../types';
import { harness, iso, signedPolicy, spendRequest } from './fixtures';
import { toSixClaimStatement } from '../six-claims';

async function allowSpendReceipt(): Promise<KernelReceipt> {
  const h = harness();
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
  const out = await runUnderKernel(spendRequest({ amount_raw: '10000' }), async () => 'paid', h.deps);
  return out.final_receipt!;
}
const clone = (r: KernelReceipt): KernelReceipt => JSON.parse(JSON.stringify(r));

describe('integrity is recomputed, not read off the hash shape', () => {
  it('a genuine receipt verifies', async () => {
    const c = toSixClaimStatement(await allowSpendReceipt()).predicate.claims;
    expect(c.integrity.status).toBe('VERIFIED');
  });

  it('a receipt edited after hashing FAILS, though its hash is still well-formed', async () => {
    const r = clone(await allowSpendReceipt());
    r.header.receipt_id = `${r.header.receipt_id}-edited`;
    const c = toSixClaimStatement(r).predicate.claims;
    expect(r.header.receipt_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.integrity.status).toBe('FAILED');
  });

  it('does not claim a chain from a single receipt', async () => {
    const c = toSixClaimStatement(await allowSpendReceipt()).predicate.claims;
    expect(c.integrity.statement).not.toMatch(/chain/i);
    expect(c.integrity.gaps.join(' ')).toMatch(/prev_hash is reported, not compared/);
  });
});

describe('authorization does not call an unverified policy signed', () => {
  it('ALLOW with the signature NOT_CHECKED: no "signed" in the statement, and a gap names it', async () => {
    const r = clone(await allowSpendReceipt());
    (r.decision.policy as { signature: string }).signature = 'NOT_CHECKED';
    const a = toSixClaimStatement(r).predicate.claims.authorization;
    expect(a.status).toBe('VERIFIED');
    expect(a.statement).not.toMatch(/signed/i);
    expect(a.gaps.join(' ')).toMatch(/policy signature NOT_CHECKED/);
  });
});

describe('containment states only what is checked', () => {
  it('no "execution boundary held"', async () => {
    const c = toSixClaimStatement(await allowSpendReceipt()).predicate.claims;
    expect(c.containment.statement).not.toMatch(/boundary held/i);
    expect(c.containment.statement).toMatch(/only under an ALLOW/);
  });
});
