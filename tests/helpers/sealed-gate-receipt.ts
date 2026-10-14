/**
 * kernel_receipts rows minted by the REAL kernel gate (runUnderKernel), for the confirmed-outcome suites.
 *
 * Since 2026-10-14 the confirmed-outcome verifier refuses any row whose sealed receipt is not a gate
 * run's (kernel/receipt-db-index.ts::gateReceiptProblem). Hand-built rows would test a fixture, not the
 * gate, so this runs the gate itself, with the kernel suites' own fixtures (in-memory ledger, a random
 * in-memory owner wallet, a signed policy), and maps the receipt to a row exactly the way
 * indexKernelReceiptToDb does.
 *
 *   status VERIFIED → HAL PASS → ALLOW → the post runs → the OUTCOME row (executed: true).
 *   status FAILED   → HAL FLAG → DENY  → nothing runs  → the DECISION row (executed: false).
 *
 * `over` is spread LAST, so a test can still tamper a column (that is how the binding is tested).
 */
import { runUnderKernel } from '../../src/kernel/gate';
import { DEFAULT_ENV } from '../../src/kernel/receipt';
import type { KernelReceipt } from '../../src/kernel/types';
import { harness, iso, postRequest, signedPolicy } from '../../src/kernel/__tests__/fixtures';
import { Wallet } from 'ethers';
import { signReceipt } from '../../src/services/receipt-signer';

// THE ENGINE RECEIPT KEY FOR TESTS. Since 2026-10-14 a row confirms only if the engine signed it
// (RECEIPT_SIGNING_KEY, the #1333 signer). A random in-memory key, generated per test process and
// never written anywhere, unless a test set one. A test that needs "no signer configured" deletes it.
if (!process.env.RECEIPT_SIGNING_KEY) process.env.RECEIPT_SIGNING_KEY = Wallet.createRandom().privateKey;

type Row = Record<string, any>;

export interface SealOptions {
  receiptId: string;
  agentId: string;
  status?: 'VERIFIED' | 'FAILED';
  settledBy?: 'holdout' | 'known_answer' | 'person' | null;
  argsHash?: string;
  simulated?: boolean;
}

export async function sealGateReceipt(o: SealOptions): Promise<KernelReceipt> {
  const pass = (o.status ?? 'VERIFIED') === 'VERIFIED';
  const h = harness({
    env: { ...DEFAULT_ENV, is_simulated: o.simulated ?? false },
    newId: () => o.receiptId,
    halCheck: async () => ({
      verdict: pass ? 'PASS' : 'FLAG',
      method: 'fact-check',
      votes: [{ family: 'a', verdict: pass ? 'PASS' : 'FAIL' }],
      settled_by: o.settledBy === undefined ? 'holdout' : o.settledBy,
      grounded: true,
      same_domain: true,
    }),
  });
  await h.ledger.appendPolicy(await signedPolicy(h.owner, { subject: o.agentId }), iso);
  const out = await runUnderKernel(
    postRequest({
      agent: { agent_id: o.agentId, agent_name: 'test-agent' },
      ...(o.argsHash ? { args_hash: o.argsHash } : {}),
    }),
    async () => 1,
    h.deps,
  );
  if (!out.final_receipt) throw new Error(`the gate sealed no receipt (${out.verdict}: ${JSON.stringify(out.reasons)})`);
  if (out.final_receipt.decision.executed !== pass) {
    throw new Error(`expected executed=${pass} for ${o.status}, got ${out.verdict} ${JSON.stringify(out.reasons)}`);
  }
  return out.final_receipt;
}

/**
 * The row indexKernelReceiptToDb would write for this receipt, plus index-time columns, including the
 * engine's DETACHED signature made with the same signer the indexer uses (null if it refuses).
 */
export async function rowFor(r: KernelReceipt, extra: Row = {}): Promise<Row> {
  const v = r.verification;
  const signed = await signReceipt(r);
  return {
    receipt_id: r.header.receipt_id,
    subject_agent_id: r.subject.agent.agent_id,
    settled_by: v.settled_by,
    verdict_label: v.verdict_label,
    verification_status: v.status,
    is_simulated: v.is_simulated,
    receipt_hash: r.header.receipt_hash,
    args_hash: r.request.args_hash,
    receipt: r,
    engine_signature: signed.ok ? signed.signature : null,
    consumed_at: null,
    ...extra,
  };
}

/** Seal through the gate from the column values a test asks for, then let `over` tamper anything. */
export async function sealedRow(id: string, agentId: string, over: Row = {}, createdAt?: string): Promise<Row> {
  const r = await sealGateReceipt({
    receiptId: id,
    agentId: typeof over['subject_agent_id'] === 'string' ? over['subject_agent_id'] : agentId,
    status: over['verification_status'] === 'FAILED' ? 'FAILED' : 'VERIFIED',
    settledBy: over['settled_by'] === undefined ? 'holdout' : over['settled_by'],
    // Only a well-formed hash can be sealed (the gate refuses anything else); a malformed one in `over`
    // stays a column tamper, which is how the content-key gate is tested.
    argsHash: typeof over['args_hash'] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(over['args_hash']) ? over['args_hash'] : undefined,
    simulated: over['is_simulated'] === true,
  });
  return await rowFor(r, { created_at: createdAt ?? new Date(Date.now() - 60_000).toISOString(), ...over });
}
