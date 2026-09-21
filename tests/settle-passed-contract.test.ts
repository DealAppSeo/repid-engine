/**
 * E4 / #644 — PASS + money path settles, or typed failure. Never a quiet NULL.
 * SYNTHETIC contract id only.
 */
import { settlePassedOrFail } from '../src/services/settle-passed-contract';

const CID = '00000000-0000-4000-8000-000000000064';

function memoryDb() {
  const rows = new Map<string, Record<string, unknown>>([
    [CID, { id: CID, status: 'fulfilled', settled_at: null, last_error: null }],
  ]);
  const x402 = new Map<string, Record<string, unknown>>([
    [CID, { idempotency_key: CID, status: 'authorized', tx_hash: null }],
  ]);
  return {
    rows,
    x402,
    async updateContract(id: string, patch: Record<string, unknown>) {
      const cur = rows.get(id) ?? {};
      rows.set(id, { ...cur, ...patch });
      return { error: null };
    },
    async updateX402(id: string, patch: Record<string, unknown>) {
      const cur = x402.get(id) ?? {};
      x402.set(id, { ...cur, ...patch });
      return { error: null };
    },
  };
}

describe('E4 settlePassedOrFail', () => {
  it('PASS + SETTLED release writes settled_at and clears last_error', async () => {
    const db = memoryDb();
    const out = await settlePassedOrFail({
      db,
      contractId: CID,
      satisfactionScore: 1,
      moneyPathEnabled: true,
      release: async () => ({ status: 'SETTLED' }),
      finalize: async () => ({
        ok: true,
        contract: { settled_at: '2026-09-15T00:00:00.000Z' },
      }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.settled_at).toBe('2026-09-15T00:00:00.000Z');
      expect(out.x402_status).toBe('settled');
    }
    expect(db.rows.get(CID)!.settled_at).toBe('2026-09-15T00:00:00.000Z');
    expect(db.rows.get(CID)!.status).toBe('settled');
    expect(db.rows.get(CID)!.last_error).toBeNull();
    expect(db.x402.get(CID)!.status).toBe('settled');
  });

  it('PASS + release FAILED writes last_error — not a quiet NULL settled_at', async () => {
    const db = memoryDb();
    const out = await settlePassedOrFail({
      db,
      contractId: CID,
      satisfactionScore: 1,
      moneyPathEnabled: true,
      release: async () => ({ status: 'FAILED', reason: 'facilitator_down' }),
      finalize: async () => {
        throw new Error('finalize must not run');
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.settled_at).toBeNull();
      expect(out.code).toBe('payment_release_failed');
      expect(out.last_error).toMatch(/facilitator_down/);
    }
    expect(db.rows.get(CID)!.settled_at).toBeNull();
    expect(db.rows.get(CID)!.last_error).toMatch(/payment_release_failed/);
    expect(db.x402.get(CID)!.status).toBe('authorized');
  });
});
