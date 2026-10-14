/**
 * confirmed-outcome-gate-binding.test.ts — XC1's re-attack of #1364, finding 2: `args_hash` is whatever
 * 32-byte hex the client sends, and the verifier only checked its shape.
 *
 * The server cannot recompute the hash: the kernel never receives the arguments, by design. So the
 * binding is to WHERE the row came from. A kernel_receipts row confirms only if its sealed receipt is
 * the kernel gate's own run and every column the verifier gates on equals that sealed body
 * (kernel/receipt-db-index.ts::gateReceiptProblem). Receipts here are minted by the REAL gate
 * (tests/helpers/sealed-gate-receipt.ts), so nothing is checked against a fixture's idea of a receipt.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { dryDecision, runUnderKernel } from '../src/kernel/gate';
import { DEFAULT_ENV, receiptHash } from '../src/kernel/receipt';
import { gateReceiptProblem } from '../src/kernel/receipt-db-index';
import type { KernelReceipt } from '../src/kernel/types';
import { harness, iso, postRequest, signedPolicy } from '../src/kernel/__tests__/fixtures';
import { rowFor, sealGateReceipt } from './helpers/sealed-gate-receipt';

const AGENT = 'agent-1';
const H = (n: number): string => '0x' + n.toString(16).padStart(64, '0');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('gateReceiptProblem — only a sealed gate-run receipt, unedited, passes', () => {
  it('a VERIFIED outcome row (the post ran under the gate) passes', async () => {
    const r = await sealGateReceipt({ receiptId: 'g-ok', agentId: AGENT, status: 'VERIFIED', argsHash: H(1) });
    expect(r.decision.executed).toBe(true);
    expect(gateReceiptProblem(rowFor(r))).toBeNull();
  });

  it('a FAILED decision row (HAL flagged it, the gate refused it, nothing ran) passes', async () => {
    const r = await sealGateReceipt({ receiptId: 'g-fail', agentId: AGENT, status: 'FAILED', argsHash: H(2) });
    expect(r.decision.executed).toBe(false);
    expect(r.verification.status).toBe('FAILED');
    expect(gateReceiptProblem(rowFor(r))).toBeNull();
  });

  it('the pre-fix hand-built row (right columns, no sealed receipt) fails', () => {
    expect(gateReceiptProblem({
      receipt_id: 'x', subject_agent_id: AGENT, settled_by: 'holdout', verdict_label: 'SETTLED',
      verification_status: 'VERIFIED', is_simulated: false, args_hash: H(3),
    })).toBe('no_sealed_receipt');
  });

  it('a client-chosen args_hash COLUMN that is not the sealed one fails', async () => {
    const r = await sealGateReceipt({ receiptId: 'g-hash', agentId: AGENT, argsHash: H(4) });
    expect(gateReceiptProblem(rowFor(r, { args_hash: H(5) }))).toBe('args_hash_mismatch');
  });

  it('an edited sealed BODY fails on its own hash', async () => {
    const r = clone(await sealGateReceipt({ receiptId: 'g-body', agentId: AGENT, argsHash: H(6) }));
    r.request.args_hash = H(7);
    expect(gateReceiptProblem(rowFor(r))).toBe('receipt_invalid:hash_mismatch');
  });

  it.each([
    ['verification_status', 'FAILED', 'verification_mismatch'],
    ['settled_by', 'known_answer', 'verification_mismatch'],
    ['is_simulated', true, 'verification_mismatch'],
    ['subject_agent_id', 'someone-else', 'subject_mismatch'],
    ['receipt_hash', H(8), 'receipt_hash_mismatch'],
    ['receipt_id', 'another-id', 'receipt_invalid:executed_without_persisted_decision'],
  ])('a %s column that disagrees with the sealed body fails', async (col, value, why) => {
    const r = await sealGateReceipt({ receiptId: 'g-col', agentId: AGENT, argsHash: H(9) });
    expect(gateReceiptProblem(rowFor(r, { [col]: value }))).toBe(why);
  });

  it('a VERIFIED decision row whose post never ran (no outcome row) pays no gain', async () => {
    const h = harness({
      env: { ...DEFAULT_ENV, is_simulated: false },
      newId: () => 'g-norun',
      halCheck: async () => ({ verdict: 'PASS', method: 'fact-check', votes: [{ family: 'a', verdict: 'PASS' }], settled_by: 'holdout', grounded: true, same_domain: true }),
    });
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { subject: AGENT }), iso);
    const out = await runUnderKernel(postRequest({ agent: { agent_id: AGENT, agent_name: 't' } }), async () => 1, h.deps);
    expect(out.decision_receipt!.decision.executed).toBe(false); // the row written BEFORE the tool ran
    expect(gateReceiptProblem(rowFor(out.decision_receipt!))).toBe('verified_but_not_run');
  });

  it('a dry preview (POST /decide) is not a gate run, even re-sealed to look valid', async () => {
    const h = harness({ env: { ...DEFAULT_ENV, is_simulated: false } });
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { subject: AGENT }), iso);
    const dry = await dryDecision(postRequest({ agent: { agent_id: AGENT, agent_name: 't' } }), h.deps);
    const preview = (dry as { receipt_preview: KernelReceipt }).receipt_preview;
    expect(gateReceiptProblem(rowFor(preview))).toBe('dry_preview');
  });

  it('RESIDUAL, pinned on purpose: a self-consistent forgery re-sealed by a service-role writer passes', async () => {
    // Receipts are hashed, not signed. Anyone who can write kernel_receipts (service role only) can
    // rebuild the body and its hash. This test exists so the limit is visible; a server signature over
    // receipt_hash is what closes it. If this starts failing because a signature landed, flip it.
    const r = clone(await sealGateReceipt({ receiptId: 'g-forge', agentId: AGENT, argsHash: H(10) }));
    r.request.args_hash = H(11);
    r.header.receipt_hash = receiptHash(r);
    expect(gateReceiptProblem(rowFor(r))).toBeNull();
  });
});

describe('runUnderKernel has NO production caller (so no production row can pass the binding)', () => {
  // [V 2026-10-14] the gate's only callers are tests. When a production caller appears, it becomes the
  // source of every confirmable receipt, and its args_hash must be hashArgs() over the arguments its
  // closure actually uses (the kernel never sees them). This tripwire makes that a deliberate change.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === '__tests__' ? [] : files(p);
      return p.endsWith('.ts') ? [p] : [];
    });

  it('no file under src/ calls runUnderKernel( outside its own definition', () => {
    const callers = files(join(__dirname, '..', 'src'))
      .filter((p) => !p.endsWith(join('kernel', 'gate.ts')))
      .filter((p) => readFileSync(p, 'utf8').split(/\r?\n/).some((l) => /runUnderKernel\(/.test(l) && !/^\s*(\*|\/\/)/.test(l)));
    expect(callers).toEqual([]);
  });
});
