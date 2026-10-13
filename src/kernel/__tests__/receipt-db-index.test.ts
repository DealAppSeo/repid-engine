/**
 * receipt-db-index.test.ts — the kernel receipt DB index is BEST-EFFORT.
 *
 * StoreLedger gained an optional `receiptIndexer` callback, invoked AFTER the authoritative JSONL
 * append succeeds. This proves the three things that matter:
 *   (1) a THROWING indexer never breaks the ledger — appendReceipt still resolves, the tool still ran,
 *       and both JSONL receipts for the call are present (so the swallow is load-bearing, not a no-op);
 *   (2) a successful indexer is awaited and sees each receipt in order (decision row, then outcome row);
 *   (3) a ledger constructed with NO indexer — every existing caller — behaves exactly as before.
 *
 * It is DB-free: the indexer is injected per test, so nothing here imports the real db client. This
 * mirrors how production (routes/kernel.ts) injects indexKernelReceiptToDb while the generic ledger and
 * every other kernel suite stay DB-free.
 */
import { Wallet } from 'ethers';
import { runUnderKernel } from '../gate';
import { StoreLedger, createMemoryStore } from '../store';
import { NOW_MS, iso, signedPolicy, spendRequest } from './fixtures';
import type { GateDeps, KernelReceipt } from '../types';

function depsFor(ledger: StoreLedger, owner: Wallet): GateDeps {
  let n = 0;
  return {
    ledger,
    resolveOwner: async () => ({ status: 'resolved', wallet: owner.address, assurance: 'wallet-proven' }),
    now: () => NOW_MS,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

describe('kernel receipt DB index is best-effort', () => {
  it('a THROWING indexer never breaks the ledger: appendReceipt resolves, the tool ran, JSONL intact', async () => {
    const sink = createMemoryStore();
    let indexerCalls = 0;
    const throwingIndexer = (): void => {
      indexerCalls++;
      throw new Error('kernel_receipts table absent'); // the exact prod-today condition
    };
    const ledger = new StoreLedger(sink, throwingIndexer);
    const owner = Wallet.createRandom();
    const deps = depsFor(ledger, owner);
    await ledger.appendPolicy(await signedPolicy(owner), iso);

    const tool = jest.fn(async () => 'paid');
    const out = await runUnderKernel(spendRequest({ amount_raw: '10000' }), tool, deps);

    // The decision path is wholly unaffected by the index-write failure.
    expect(out.verdict).toBe('ALLOW');
    expect(out.executed).toBe(true);
    expect(tool).toHaveBeenCalledTimes(1);
    // The indexer WAS invoked for each appended receipt (decision row + outcome row) and threw both
    // times — so the swallow is what kept appendReceipt resolving, not a skipped call.
    expect(indexerCalls).toBe(2);
    // The authoritative JSONL ledger holds both receipts for the one call.
    expect(sink.records.filter((r) => r.kind === 'receipt')).toHaveLength(2);
  });

  it('a successful indexer is awaited and sees each receipt in order (decision row, then outcome row)', async () => {
    const sink = createMemoryStore();
    const seen: Array<{ id: string; executed: boolean }> = [];
    const ledger = new StoreLedger(sink, async (r: KernelReceipt) => {
      seen.push({ id: r.header.receipt_id, executed: r.decision.executed });
    });
    const owner = Wallet.createRandom();
    await ledger.appendPolicy(await signedPolicy(owner), iso);
    await runUnderKernel(spendRequest({ amount_raw: '10000' }), async () => 'paid', depsFor(ledger, owner));

    expect(seen).toHaveLength(2);
    expect(seen[0]!.executed).toBe(false); // decision row first
    expect(seen[1]!.executed).toBe(true); // then the outcome row, same call id
    expect(seen[0]!.id).toBe(seen[1]!.id);
  });

  it('a ledger with NO indexer (every existing caller) behaves exactly as before', async () => {
    const sink = createMemoryStore();
    const ledger = new StoreLedger(sink); // no second arg — the pre-existing constructor shape
    const owner = Wallet.createRandom();
    await ledger.appendPolicy(await signedPolicy(owner), iso);
    const out = await runUnderKernel(spendRequest({ amount_raw: '10000' }), async () => 'paid', depsFor(ledger, owner));
    expect(out.verdict).toBe('ALLOW');
    expect(sink.records.filter((r) => r.kind === 'receipt')).toHaveLength(2);
  });
});
