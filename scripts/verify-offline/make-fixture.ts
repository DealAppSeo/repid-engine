/**
 * make-fixture.ts — write the verify-offline fixtures with the REAL kernel gate.
 *
 *   npx ts-node scripts/verify-offline/make-fixture.ts      (rewrites fixtures/; byte-identical on re-run)
 *
 * Nothing here is hand-built: runUnderKernel decides, the StoreLedger seals and chains, and the engine's
 * own receipt signer signs. The keys are THROWAWAYS derived from public labels (keccak of a fixed
 * string), so anyone can regenerate them: they hold nothing, are never funded and sign no transaction.
 * No chain is dialled: the owner is a plain key pair, and the chain stub throws if anything asks.
 *
 * ledger.jsonl           trustshell-evidence/1 records: a policy, then 5 calls: spend ALLOW (decision +
 *                        outcome), spend over the per-tx cap (DENY), the same spend replayed (DENY), a
 *                        post HAL passed (ALLOW, decision + outcome), a spend to an unlisted payee (DENY).
 * ledger.tampered.jsonl  the first allowed spend re-pointed at another payee, then every hash and link
 *                        re-sealed so the chain is self-consistent: the rewrite only someone holding the
 *                        ledger can do. It must FAIL (owner policy + engine signature).
 * evidence-card.json     CAPTURED, not generated: `trustshell check <public run> --claims-file … --json`
 *                        on repid-engine CI run 39610093655 (2026-10-21). Kept exactly as trustshell wrote it.
 * evidence-card.tampered.json  that card with its CONTRADICTED commit claim flipped to SUPPORTED and the
 *                        unsigned digest recomputed, as anyone holding the file could. It must FAIL.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '../../src/services/owner-authorization';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { runUnderKernel } from '../../src/kernel/gate';
import { hashArgs, receiptHash } from '../../src/kernel/receipt';
import type { KernelReceipt, LedgerRecord } from '../../src/kernel/types';
import { signReceipt } from '../../src/services/receipt-signer';
import { NOW_MS, harness, iso, postRequest, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';

const throwaway = (label: string) => new Wallet(keccak256(toUtf8Bytes(`hyperdag/verify-offline/${label}/v1`)));
export const ATTACKER_PAYEE = '0x00000000000000000000000000000000000BEEF0';
export const FORMAT = 'trustshell-evidence/1';
export const FIXTURE_DIR = join(__dirname, 'fixtures');

type KernelLine = LedgerRecord & { engine_signature?: unknown };

/** Wrap a kernel ledger line in the one evidence-record envelope. The record itself is unchanged. */
export function envelope(rec: KernelLine): Record<string, unknown> {
  return rec.kind === 'policy'
    ? { format: FORMAT, kind: 'owner-policy', record: rec.policy }
    : { format: FORMAT, kind: 'kernel-receipt', record: rec.receipt, ...(rec.engine_signature ? { engine_signature: rec.engine_signature } : {}) };
}

/** The captured card with one verdict flipped and its (unsigned) RFC 8785 digest recomputed. */
export function tamperCard(cardJson: string): string {
  const card = JSON.parse(cardJson);
  const c = card.record.claims.find((x: { template: string; status: string }) => x.template === 'git.head_sha' && x.status === 'CONTRADICTED');
  if (!c) throw new Error('the captured card has no CONTRADICTED commit claim to flip');
  c.status = 'SUPPORTED';
  card.digest.value = createHash('sha256').update(canonicalJson(card.record), 'utf8').digest('hex');
  return JSON.stringify(card, null, 2) + '\n';
}

export interface Fixtures {
  ledger: string;
  tampered: string;
  /** The same ledger exactly as the kernel's JSONL store writes it, unwrapped. */
  raw: string;
  owner: string;
  engineSigner: string;
}

export async function buildFixtures(): Promise<Fixtures> {
  const owner = throwaway('fixture-owner');
  const engine = throwaway('fixture-engine-signer');
  let t = NOW_MS;
  const h = harness({
    resolveOwner: async () => ({ status: 'resolved', wallet: owner.address, assurance: 'wallet-proven' }),
    now: () => t,
    chain: {
      getCode: async () => { throw new Error('offline fixture: no chain'); },
      call: async () => { throw new Error('offline fixture: no chain'); },
    },
    halCheck: async () => ({
      verdict: 'PASS',
      method: 'fact-check',
      votes: [{ family: 'llama', verdict: 'PASS' }, { family: 'qwen', verdict: 'PASS' }],
      settled_by: null,
      grounded: true,
      same_domain: true,
    }),
  });

  await h.ledger.appendPolicy(await signedPolicy(owner), iso);
  const tool = async () => ({ ok: true });
  const paid = spendRequest({ amount_raw: 250000, args_hash: hashArgs({ resource: 'https://example.invalid/paid/1' }) });
  const calls = [
    paid, // ALLOW
    spendRequest({ amount_raw: 2000000, args_hash: hashArgs({ resource: 'https://example.invalid/paid/2' }) }), // over per-tx
    paid, // replay of the first: one use only
    postRequest(), // HAL PASS
    spendRequest({ payee: ATTACKER_PAYEE, args_hash: hashArgs({ resource: 'https://example.invalid/paid/3' }) }), // unlisted payee
  ];
  const expected = ['ALLOW', 'DENY', 'DENY', 'ALLOW', 'DENY'];
  for (const [i, req] of calls.entries()) {
    t += 60_000;
    const out = await runUnderKernel(req, tool, h.deps);
    if (out.verdict !== expected[i]) throw new Error(`call ${i + 1}: expected ${expected[i]}, the kernel said ${out.verdict} ${JSON.stringify(out.reasons)}`);
  }

  // The engine signs each receipt the way the DB index does (receipt-db-index.ts), with a throwaway key.
  const saved = process.env.RECEIPT_SIGNING_KEY;
  process.env.RECEIPT_SIGNING_KEY = engine.privateKey;
  const lines: KernelLine[] = [];
  try {
    for (const rec of h.sink.records) {
      if (rec.kind !== 'receipt') { lines.push(rec); continue; }
      const s = await signReceipt(rec.receipt);
      if (!s.ok) throw new Error(`engine signer refused: ${s.reason}`);
      lines.push({ ...rec, engine_signature: { ...s.signature, signed_at: rec.receipt.header.created_at } });
    }
  } finally {
    if (saved === undefined) delete process.env.RECEIPT_SIGNING_KEY;
    else process.env.RECEIPT_SIGNING_KEY = saved;
  }
  const toJsonl = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';

  // The tamper: re-point the first allowed spend (decision and outcome rows) at another payee, then
  // re-seal every receipt from there on so each hash and prev_hash is consistent again.
  const forged = JSON.parse(JSON.stringify(lines)) as typeof lines;
  let prev: KernelReceipt | null = null;
  for (const rec of forged) {
    if (rec.kind !== 'receipt') continue;
    const r = rec.receipt;
    if (r.decision.verdict === 'ALLOW' && r.request.tool.class === 'spend') {
      r.request.payee = ATTACKER_PAYEE;
      r.payment.payee = ATTACKER_PAYEE;
    }
    r.header.prev_hash = prev ? prev.header.receipt_hash : null;
    r.header.receipt_hash = receiptHash(r);
    prev = r;
  }

  return { ledger: toJsonl(lines.map(envelope)), tampered: toJsonl(forged.map(envelope)), raw: toJsonl(lines), owner: owner.address, engineSigner: engine.address };
}

if (require.main === module) {
  buildFixtures().then((f) => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(join(FIXTURE_DIR, 'ledger.jsonl'), f.ledger);
    writeFileSync(join(FIXTURE_DIR, 'ledger.tampered.jsonl'), f.tampered);
    const card = join(FIXTURE_DIR, 'evidence-card.json');
    if (existsSync(card)) writeFileSync(join(FIXTURE_DIR, 'evidence-card.tampered.json'), tamperCard(readFileSync(card, 'utf8')));
    console.log(`wrote ${FIXTURE_DIR}\n  --owner ${f.owner}\n  --engine-signer ${f.engineSigner}`);
  });
}
