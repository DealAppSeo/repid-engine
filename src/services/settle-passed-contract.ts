/**
 * E4 / #644 — PASS + fulfilled must settle, or leave a typed failure.
 * A quiet NULL settled_at after PASS is the bug.
 */
export interface SettlementRow {
  settled_at: string | null;
  last_error: string | null;
  status?: string;
}

export type SettleOutcome =
  | { ok: true; settled_at: string; last_error: null; x402_status: 'settled' }
  | { ok: false; settled_at: null; last_error: string; code: string; x402_status: string | null };

export interface SettleDb {
  updateContract(id: string, patch: Record<string, unknown>): Promise<{ error: string | null }>;
  /** F1: x402 row keyed by contract id (idempotency_key). */
  updateX402?(id: string, patch: Record<string, unknown>): Promise<{ error: string | null }>;
}

export function typedSettlementFailure(code: string, message: string): SettleOutcome {
  return { ok: false, settled_at: null, last_error: `${code}: ${message}`, code, x402_status: null };
}

/**
 * After a PASS verdict: either finalize settlement or write last_error.
 * Never returns ok:true with settled_at null.
 */
export async function settlePassedOrFail(args: {
  db: SettleDb;
  contractId: string;
  satisfactionScore: number;
  moneyPathEnabled: boolean;
  release?: () => Promise<{ status: string; reason?: string }>;
  finalize: (a: {
    contractId: string;
    satisfactionScore: number;
  }) => Promise<{ ok: boolean; error?: string; contract?: { settled_at?: string | null } }>;
}): Promise<SettleOutcome> {
  if (args.moneyPathEnabled) {
    if (!args.release) {
      const fail = typedSettlementFailure('money_path_missing', 'PASS but no release function');
      await args.db.updateContract(args.contractId, { last_error: fail.last_error });
      return fail;
    }
    const released = await args.release();
    const okPay =
      released.status === 'SETTLED' ||
      released.status === 'ALREADY_SETTLED' ||
      released.status === 'SETTLED_UNRECORDED';
    if (!okPay) {
      const fail = typedSettlementFailure(
        'payment_release_failed',
        released.reason || released.status,
      );
      await args.db.updateContract(args.contractId, { last_error: fail.last_error });
      return fail;
    }
  }

  const finalized = await args.finalize({
    contractId: args.contractId,
    satisfactionScore: args.satisfactionScore,
  });
  if (!finalized.ok) {
    const fail = typedSettlementFailure('finalize_failed', finalized.error || 'unknown');
    await args.db.updateContract(args.contractId, { last_error: fail.last_error });
    return fail;
  }
  const settledAt = finalized.contract?.settled_at ?? new Date().toISOString();
  await args.db.updateContract(args.contractId, {
    last_error: null,
    status: 'settled',
    settled_at: settledAt,
  });
  if (args.db.updateX402) {
    await args.db.updateX402(args.contractId, { status: 'settled' });
  }
  return { ok: true, settled_at: settledAt, last_error: null, x402_status: 'settled' };
}
