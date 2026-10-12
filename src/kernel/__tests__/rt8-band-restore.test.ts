/**
 * RT-8 — a PROVISIONAL vote must not count toward restoring a band.
 *
 * FOUND by XC1's red team of the kernel (branch claude/bold-turing-icz50x-kernel-redteam,
 * tests/kernel/red-team.test.ts), where it is an `it.failing` test plus a CHARACTERISE test that
 * pins the breach. This is that test, ported here so this fix does not depend on that branch, and
 * flipped to passing.
 *
 * THE DEFECT. `counts_toward_band_restore` was derived as `grounded && same_domain && !is_simulated`
 * and did not look at `verdict_label`. So a grounded, same-domain 2-1 vote, which is PROVISIONAL by
 * its own label, COUNTED toward restoring a band as soon as the environment was not simulated, and
 * the receipt validated because the validator enforced the same (wrong) derivation. That contradicts
 * Sean's invariant: the score moves on a holdout, a known answer or a person, never on a vote.
 *
 * DORMANT TODAY, which is why this is "fix before real spend" and not an incident: DEFAULT_ENV is
 * simulated and nothing in the repo builds a non-simulated env. The tests below build one on purpose.
 *
 * Three groups, because a fix that is only "PROVISIONAL → false" is also passed by a derivation that
 * is always false:
 *   1. the breach is closed;
 *   2. positive controls: a SETTLED, grounded, same-domain, real run STILL counts (all three settlers);
 *   3. the validator refuses a receipt that claims the old, wrong value.
 */
import { runUnderKernel } from '../gate';
import { DEFAULT_ENV, receiptHash, validateReceipt } from '../receipt';
import type { HalEvidence, KernelReceipt } from '../types';
import { harness, iso, postRequest, signedPolicy } from './fixtures';

const REAL = { ...DEFAULT_ENV, is_simulated: false };

/** A 2-1 vote, grounded and same-domain, with no settler: PROVISIONAL by construction. */
const twoOne = (over: Partial<HalEvidence> = {}): HalEvidence => ({
  verdict: 'PASS',
  method: 'fact-check',
  votes: [
    { family: 'a', verdict: 'PASS' },
    { family: 'b', verdict: 'PASS' },
    { family: 'c', verdict: 'FAIL' },
  ],
  settled_by: null,
  grounded: true,
  same_domain: true,
  ...over,
});

async function post(env: typeof REAL, evidence: HalEvidence): Promise<KernelReceipt> {
  const h = harness({ env, halCheck: async () => evidence });
  await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
  const out = await runUnderKernel(postRequest(), jest.fn(async () => 1), h.deps);
  return out.decision_receipt!;
}

describe('RT-8 band restore requires settlement', () => {
  it('a PROVISIONAL (unsettled) vote must not count toward band restore, even in a real environment', async () => {
    const r = await post(REAL, twoOne());
    const v = r.verification;
    expect(v.verdict_label).toBe('PROVISIONAL');
    // every other ingredient IS present, so the only thing keeping this false is the missing settler
    expect(v.grounded && v.same_domain && !v.is_simulated).toBe(true);
    expect(v.counts_toward_band_restore).toBe(false);
    expect(validateReceipt(r).ok).toBe(true);
  });

  it('a unanimous 3-0 vote is still only a vote: PROVISIONAL, and it does not count', async () => {
    const r = await post(
      REAL,
      twoOne({ votes: [{ family: 'a', verdict: 'PASS' }, { family: 'b', verdict: 'PASS' }, { family: 'c', verdict: 'PASS' }] }),
    );
    expect(r.verification.verdict_label).toBe('PROVISIONAL');
    expect(r.verification.counts_toward_band_restore).toBe(false);
  });

  it('a SIMULATED run never counts, whatever the vote or the settler says', async () => {
    const r = await post(DEFAULT_ENV, twoOne({ settled_by: 'person' }));
    expect(r.verification.is_simulated).toBe(true);
    expect(r.verification.counts_toward_band_restore).toBe(false);
  });
});

describe('RT-8 positive controls: settlement still restores a band', () => {
  it.each(['holdout', 'known_answer', 'person'] as const)('settled_by %s, grounded, same-domain, real -> counts, and validates', async (settler) => {
    const r = await post(REAL, twoOne({ settled_by: settler }));
    const v = r.verification;
    expect(v.verdict_label).toBe('SETTLED');
    expect(v.settled_by).toBe(settler);
    expect(v.counts_toward_band_restore).toBe(true);
    expect(validateReceipt(r).ok).toBe(true);
  });

  it('a settled run still loses the flag if it is ungrounded, or not in the same domain', async () => {
    expect((await post(REAL, twoOne({ settled_by: 'holdout', grounded: false }))).verification.counts_toward_band_restore).toBe(false);
    expect((await post(REAL, twoOne({ settled_by: 'holdout', same_domain: false }))).verification.counts_toward_band_restore).toBe(false);
  });
});

describe('RT-8 the validator enforces the same derivation', () => {
  it('a receipt that claims a PROVISIONAL vote counts is invalid (it used to validate)', async () => {
    const r = JSON.parse(JSON.stringify(await post(REAL, twoOne()))) as KernelReceipt;
    r.verification.counts_toward_band_restore = true; // the OLD derivation's answer
    r.header.receipt_hash = receiptHash(r); // an attacker can recompute the (unkeyed) hash
    const v = validateReceipt(r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('band_restore_not_derived');
  });
});
