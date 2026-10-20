/**
 * P0 CONTAIN (Trust Harness, 2026-10-19) — runUnderKernel run counts, one fixture per verdict.
 *
 *   ALLOW                         → the tool runs EXACTLY once
 *   DENY                          → zero runs
 *   NOT_CHECKED                   → zero runs
 *   decision receipt append fails → zero runs
 *
 * In-memory only (the kernel's own memory store + a throwaway owner wallet from the kernel
 * fixtures). No chain, no DB. This is CC1-A's own file; it does not touch XC1's red-team suite.
 */
import { runUnderKernel } from '../src/kernel/gate';
import type { KernelLedger } from '../src/kernel/types';
import { harness, iso, postRequest, signedPolicy, spendRequest } from '../src/kernel/__tests__/fixtures';

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

describe('runUnderKernel: how many times the tool runs, per verdict', () => {
  it('ALLOW → exactly one run', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
    expect(out.executed).toBe(true);
  });

  it('DENY (per-tx limit 0) → zero runs', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '0' }), iso);
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.executed).toBe(false);
  });

  it('NOT_CHECKED (a post with no HAL wired) → zero runs', async () => {
    const h = harness(); // no halCheck dep
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(postRequest(), tool, h.deps);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.executed).toBe(false);
  });

  it('NOT_CHECKED (owner lookup throws) → zero runs', async () => {
    const h = harness({ resolveOwner: async () => { throw new Error('owner store down'); } });
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest(), tool, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(0);
  });

  it('decision receipt append fails on a would-be ALLOW → zero runs, reported NOT_CHECKED', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    // Same ledger, except the receipt write throws. Policy reads still work.
    const failing: KernelLedger = new Proxy(h.ledger, {
      get(target, prop, receiver) {
        if (prop === 'appendReceipt') return async () => { throw new Error('ledger write failed'); };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const tool = jest.fn(async () => 'ran');
    const out = await runUnderKernel(spendRequest({ amount_raw: 10000 }), tool, { ...h.deps, ledger: failing });
    expect(tool).toHaveBeenCalledTimes(0);
    expect(out.executed).toBe(false);
    expect(out.verdict).toBe('NOT_CHECKED');
    expect(codes(out)).toContain('receipt_write_failed');
  });
});
