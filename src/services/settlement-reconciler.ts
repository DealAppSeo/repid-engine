/**
 * settlement-reconciler.ts — find the places where our ledger disagrees with the chain.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-01 a contract sat marked `settled` while its settlement row was
 * stuck at `status='settling'` with a NULL tx_hash. The transfer was real —
 * 0x11dd9fd6…, block 44896192, 0.10 USDC — and had been for twelve hours.
 * Nothing surfaced it. It was found by hand, while investigating an unrelated
 * metric question.
 *
 * The bug that caused it was fixed. **Fixing a bug does not repair the rows it
 * already damaged, and nothing was watching for the damage.** That is the gap
 * this closes: a standing detector, so the next divergence is found by a query
 * instead of by luck.
 *
 * WHAT IT LOOKS FOR
 * -----------------
 * Each class is a specific way the money story and the database story can come
 * apart. They are reported separately because the remedies differ.
 *
 * REPORT-ONLY BY DEFAULT. Reconciling means asserting an on-chain fact, so it
 * requires a verified receipt from the chain — never a guess from proximity in
 * time, which is how a "reconciliation" turns into fabrication.
 */
import { db } from '../db';

export type OrphanKind =
  /** Contract says settled; the settlement row never recorded a tx. Money may or may not have moved. */
  | 'SETTLED_WITHOUT_TX'
  /** A release started and never finished. The single most dangerous state: a transfer may be on-chain. */
  | 'STUCK_SETTLING'
  /** Authorization taken, never released or voided, and its validity window has passed. */
  | 'AUTHORIZATION_EXPIRED'
  /** Contract settled but no settlement row at all. */
  | 'SETTLED_NO_SETTLEMENT_ROW'
  /** Real money moved but the contract never reached settled. */
  | 'PAID_BUT_NOT_SETTLED';

export interface Orphan {
  kind: OrphanKind;
  contract_id: string | null;
  settlement_id: string | null;
  tx_hash: string | null;
  detail: string;
  /** What a human should do. Deliberately not automated. */
  remedy: string;
}

export interface ReconcileReport {
  checked_at: string;
  orphans: Orphan[];
  counts: Record<string, number>;
  healthy: boolean;
}

export async function findSettlementOrphans(): Promise<ReconcileReport> {
  const orphans: Orphan[] = [];

  // 1 + 4 — contracts that claim to be settled.
  const { data: settledContracts } = await db
    .from('service_contracts')
    .select('id, status, settled_at')
    .eq('status', 'settled');

  for (const c of settledContracts ?? []) {
    const { data: s } = await db
      .from('x402_settlements')
      .select('id, status, tx_hash, is_simulated')
      .eq('idempotency_key', c.id)
      .maybeSingle();

    if (!s) {
      orphans.push({
        kind: 'SETTLED_NO_SETTLEMENT_ROW',
        contract_id: c.id,
        settlement_id: null,
        tx_hash: null,
        detail: 'contract is settled but has no x402_settlements row',
        remedy: 'Establish whether money moved. If it did, record it; if not, the contract status is wrong.',
      });
      continue;
    }
    if (!s.is_simulated && !s.tx_hash) {
      orphans.push({
        kind: s.status === 'settling' ? 'STUCK_SETTLING' : 'SETTLED_WITHOUT_TX',
        contract_id: c.id,
        settlement_id: String(s.id),
        tx_hash: null,
        detail: `contract settled, settlement status='${s.status}', tx_hash NULL — the ledger cannot say whether money moved`,
        remedy:
          'Check the payer and provider addresses on Base Sepolia around settled_at. If a transfer exists, record the tx hash under a guarded UPDATE. Never infer one from timing.',
      });
    }
  }

  // 2 — releases that began and never finished, contract-linked or not.
  const { data: settling } = await db
    .from('x402_settlements')
    .select('id, idempotency_key, tx_hash, created_at')
    .eq('status', 'settling');

  for (const s of settling ?? []) {
    if (orphans.some((o) => o.settlement_id === String(s.id))) continue;
    orphans.push({
      kind: 'STUCK_SETTLING',
      contract_id: s.idempotency_key ?? null,
      settlement_id: String(s.id),
      tx_hash: s.tx_hash ?? null,
      detail: `settlement stuck in 'settling' since ${s.created_at} — a broadcast may have succeeded without being recorded`,
      remedy: 'Verify on-chain before doing anything. A retry against a settling row is refused, so there is no double-spend risk while it sits.',
    });
  }

  // 3 — authorizations held past their usefulness.
  const { data: authorized } = await db
    .from('x402_settlements')
    .select('id, idempotency_key, created_at')
    .eq('status', 'authorized');

  const cutoff = Date.now() - 3600_000; // EIP-3009 windows here are 1h
  for (const s of authorized ?? []) {
    if (Date.parse(String(s.created_at)) < cutoff) {
      orphans.push({
        kind: 'AUTHORIZATION_EXPIRED',
        contract_id: s.idempotency_key ?? null,
        settlement_id: String(s.id),
        tx_hash: null,
        detail: `authorization held since ${s.created_at}, past the ~1h signature window — it can no longer be settled`,
        remedy:
          'The provider may have done work that can no longer be paid from this authorization. Void it and route to dispute; do not silently drop it.',
      });
    }
  }

  // 5 — money moved, contract never closed.
  const { data: paid } = await db
    .from('x402_settlements')
    .select('id, idempotency_key, tx_hash')
    .eq('status', 'settled')
    .eq('is_simulated', false)
    .not('tx_hash', 'is', null);

  for (const s of paid ?? []) {
    if (!s.idempotency_key) continue;
    const { data: c } = await db
      .from('service_contracts')
      .select('id, status')
      .eq('id', s.idempotency_key)
      .maybeSingle();
    if (c && c.status !== 'settled') {
      orphans.push({
        kind: 'PAID_BUT_NOT_SETTLED',
        contract_id: c.id,
        settlement_id: String(s.id),
        tx_hash: s.tx_hash,
        detail: `real payment ${s.tx_hash} recorded, but the contract is '${c.status}' — the provider was paid for a contract that never closed`,
        remedy: 'Establish why the lifecycle stalled after payment. The buyer has been debited.',
      });
    }
  }

  const counts: Record<string, number> = {};
  for (const o of orphans) counts[o.kind] = (counts[o.kind] ?? 0) + 1;

  return {
    checked_at: new Date().toISOString(),
    orphans,
    counts,
    healthy: orphans.length === 0,
  };
}

export function formatReconcileReport(r: ReconcileReport): string {
  const lines = [`Settlement reconciliation — ${r.checked_at}`, ''];
  if (r.healthy) {
    lines.push('  ✓ no divergence between the ledger and the money path.');
    lines.push('');
    lines.push('  This checks the classes we know how to name. It is not proof that');
    lines.push('  every row matches the chain — only an on-chain sweep would be.');
    return lines.join('\n');
  }
  for (const [kind, n] of Object.entries(r.counts)) lines.push(`  ${String(n).padStart(3)}  ${kind}`);
  lines.push('');
  for (const o of r.orphans) {
    lines.push(`  [${o.kind}] contract=${o.contract_id ?? '—'} settlement=${o.settlement_id ?? '—'}`);
    lines.push(`      ${o.detail}`);
    lines.push(`      REMEDY: ${o.remedy}`);
  }
  lines.push('');
  lines.push('  Nothing was changed. Reconciling asserts an on-chain fact and needs a');
  lines.push('  verified receipt — never an inference from timing.');
  return lines.join('\n');
}
