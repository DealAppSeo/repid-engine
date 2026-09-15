/**
 * F1 — one scratch contract reaches settled. LOCAL_MODE, synthetic ids, no prod.
 */
process.env.LOCAL_MODE = 'true';
process.env.LOCAL_STORE_PATH = ':memory:';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CID = '00000000-0000-4000-8000-0000000000f1';

describe('F1 scratch contract settles', () => {
  let tmp: string;
  let settlePassedOrFail: typeof import('../src/services/settle-passed-contract').settlePassedOrFail;
  let createLocalStore: typeof import('../src/selfhost/local-store').createLocalStore;

  beforeAll(() => {
    process.env.LOCAL_MODE = 'true';
    tmp = mkdtempSync(join(tmpdir(), 'f1-settle-'));
    process.env.LOCAL_STORE_PATH = join(tmp, 'store.db');
    jest.resetModules();
    ({ settlePassedOrFail } = require('../src/services/settle-passed-contract'));
    ({ createLocalStore } = require('../src/selfhost/local-store'));
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('PASS + SETTLED release writes settled_at and x402 settled on the scratch store', async () => {
    const store = createLocalStore(process.env.LOCAL_STORE_PATH);
    try {
      await store.from('service_contracts').insert({
        id: CID,
        status: 'fulfilled',
        settled_at: null,
        last_error: null,
      });
      await store.from('x402_settlements').insert({
        idempotency_key: CID,
        status: 'authorized',
        amount: 100001,
        prediction_topic: 'scratch',
        tip_id: CID,
        is_simulated: true,
        asset: 'USDC',
      });

      const db = {
        async updateContract(id: string, patch: Record<string, unknown>) {
          await store.from('service_contracts').update(patch).eq('id', id);
          return { error: null };
        },
        async updateX402(id: string, patch: Record<string, unknown>) {
          await store.from('x402_settlements').update(patch).eq('idempotency_key', id);
          return { error: null };
        },
      };

      const out = await settlePassedOrFail({
        db,
        contractId: CID,
        satisfactionScore: 1,
        moneyPathEnabled: true,
        release: async () => ({ status: 'SETTLED', txHash: '0x' + 'ab'.repeat(32) }),
        finalize: async () => ({
          ok: true,
          contract: { settled_at: '2026-09-15T12:00:00.000Z' },
        }),
      });

      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.settled_at).toBeTruthy();
        expect(out.x402_status).toBe('settled');
      }
      const contract = (await store.from('service_contracts').select('*').eq('id', CID)).data;
      const row = Array.isArray(contract) ? contract[0] : contract;
      expect(row.settled_at).toBeTruthy();
      expect(row.status).toBe('settled');
      const x402 = (await store.from('x402_settlements').select('*').eq('idempotency_key', CID)).data;
      const xrow = Array.isArray(x402) ? x402[0] : x402;
      expect(xrow.status).toBe('settled');
    } finally {
      store.close();
    }
  });
});
