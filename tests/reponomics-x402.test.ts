/**
 * Reponomics — x402 server contract tests.
 *
 * createTipRequest returns a 402 with the Coinbase-spec-shaped body.
 * deliverTip rejects without X-PAYMENT, accepts with simulated payment.
 */

jest.mock('../src/db', () => {
  const tipRow: any = {
    id: 'tip_test_1',
    agent_id: 'a-1',
    bet_amount: '1500000',
    status: 'awaiting_payment',
    prediction_payload: { topic: 'NBA Finals winner' },
  };
  let storedTip: any = tipRow;
  const builder: any = {
    select: () => builder,
    eq: (field: string, value: string) => {
      if (field === 'id') {
        return { ...builder, _eqId: value };
      }
      return builder;
    },
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    maybeSingle: async () => ({ data: storedTip, error: null }),
    single: async () => ({ data: storedTip, error: null }),
  };
  return {
    db: {
      from: () => builder,
      rpc: async () => ({ data: { id: 1 }, error: null }),
    },
    _setTip: (t: any) => { storedTip = t; },
  };
});

import { createTipRequest, deliverTip } from '../src/services/x402-server';

describe('x402-server — createTipRequest', () => {
  beforeAll(() => { delete process.env.X402_REAL_RPC; });

  it('returns HTTP 402 with x402 spec shape', async () => {
    const r = await createTipRequest({
      requestor_agent_id: 'requestor-1',
      provider_agent_id: 'provider-1',
      prediction_topic: 'NBA Finals winner',
    });
    expect(r.status).toBe(402);
    expect(r.body.x402Version).toBe(1);
    expect(r.body.error).toBe('Payment required');
    expect(r.body.is_simulated).toBe(true);
    expect(r.body.tip_id).toMatch(/^tip_/);

    expect(r.body.accepts).toHaveLength(1);
    const a = r.body.accepts[0]!;
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('base-sepolia');
    expect(a.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a.amount).toMatch(/^\d+$/);
    expect(a.resource).toMatch(/^\/api\/v1\/tip\/deliver\/tip_/);
  });
});

describe('x402-server — deliverTip', () => {
  it('rejects without X-PAYMENT header', async () => {
    const r = await deliverTip({ tipId: 'tip_test_1', xPaymentHeader: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/X-PAYMENT/);
  });

  it('delivers with simulated payment', async () => {
    const r = await deliverTip({ tipId: 'tip_test_1', xPaymentHeader: '0x_simulated_tx_hash', payerAddress: '0xdeadbeef' });
    expect(r.ok).toBe(true);
    expect(r.is_simulated).toBe(true);
    expect(r.content).toMatch(/mock tip/);
  });

  it('rejects when tip is not awaiting_payment', async () => {
    // Re-mock state to simulate already-delivered tip
    const dbMod: any = require('../src/db');
    dbMod._setTip({ id: 'tip_test_2', agent_id: 'a-1', bet_amount: '1500000', status: 'delivered', prediction_payload: {} });
    const r = await deliverTip({ tipId: 'tip_test_2', xPaymentHeader: '0xtx' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found or already delivered/);
  });
});
