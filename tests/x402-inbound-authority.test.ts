/**
 * x402-inbound tier-ceiling enforcement (Task 1) + self-dealing guard (Task 3).
 *
 * Mocks the facilitator (no network), the attestation service, the x402-gate
 * authority policy, and the db. Verifies:
 *   - unauthorized tier → HTTP 402 with denial_reason + failure_class + next_step
 *     and NO settlement attempted
 *   - authorized tier → settlement path runs (200)
 *   - self-dealing (payer wallet == payee wallet) → 402 self_dealing_forbidden
 */

(global as any)._api_key_versions_table_checked = true;
(global as any).__inboundAgentRow = null;
(global as any).__inboundVerify = { valid: true, payer: '0xPAYER' };
(global as any).__inboundAuthority = { authorized: true, denial_reason: null, tier: 'ESTABLISHED', per_tx_limit: 100, daily_limit: 1000, daily_remaining: 1000 };
(global as any).__settleCalled = false;

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          const r = (global as any).__inboundAgentRow;
          return { data: r, error: r ? null : null };
        },
        insert: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/services/x402-facilitator', () => ({
  x402Facilitator: {
    buildPaymentRequirements: () => [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', asset: '0xUSDC', payTo: '0xPAY', resource: 'r', mimeType: 'application/json' }],
    verifyPayment: async () => (global as any).__inboundVerify,
    extractRepIdAttestation: () => null,
    settlePayment: async () => { (global as any).__settleCalled = true; return { success: true, txHash: '0xreal', network: 'base-sepolia', payer: '0xPAYER' }; },
    queueFailure: async () => {},
  },
}));

jest.mock('../src/services/repid-attestation', () => ({
  repIdAttestationService: {
    verifyAttestation: async () => ({ valid: true }),
    generateAttestation: async () => ({ agent_id: 'x', repid: 1, tier: 'ESTABLISHED' }),
  },
}));

jest.mock('../src/services/x402-gate', () => ({
  checkTransactionAuthority: async () => (global as any).__inboundAuthority,
}));

import request from 'supertest';
import app from '../src/index';

const UUID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  (global as any).__inboundAgentRow = {
    id: UUID, agent_name: 'SOPHIA', wallet_address: '0xPAYEE', current_repid: 1200, tier: 'ESTABLISHED',
  };
  (global as any).__inboundVerify = { valid: true, payer: '0xPAYER' };
  (global as any).__inboundAuthority = { authorized: true, denial_reason: null, tier: 'ESTABLISHED', per_tx_limit: 100, daily_limit: 1000, daily_remaining: 1000, daily_used: 0 };
  (global as any).__settleCalled = false;
});

describe('POST /api/v1/x402/:uuid/trade-analysis — tier-ceiling gate (Task 1)', () => {
  it('402s with denial_reason and does NOT settle when tier authority is denied', async () => {
    (global as any).__inboundAuthority = {
      authorized: false, denial_reason: 'tier_probationary_cannot_transact',
      tier: 'PROBATIONARY', per_tx_limit: 0, daily_limit: 0, daily_remaining: 0, daily_used: 0,
    };
    const res = await request(app)
      .post(`/api/v1/x402/${UUID}/trade-analysis`)
      .set('X-PAYMENT', 'dummy-header');
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('tier_authority_denied');
    expect(res.body.denial_reason).toBe('tier_probationary_cannot_transact');
    expect(res.body.failure_class).toBe('PERMANENT');
    expect(res.body.next_step).toBeTruthy();
    expect((global as any).__settleCalled).toBe(false);
  });

  it('classifies insufficient_stake as RECOVERABLE with a stake next_step', async () => {
    (global as any).__inboundAuthority = {
      authorized: false, denial_reason: 'insufficient_stake',
      tier: 'EARNING', per_tx_limit: 10, daily_limit: 50, daily_remaining: 50, daily_used: 0,
    };
    const res = await request(app)
      .post(`/api/v1/x402/${UUID}/trade-analysis`)
      .set('X-PAYMENT', 'dummy-header');
    expect(res.status).toBe(402);
    expect(res.body.failure_class).toBe('RECOVERABLE');
    expect(res.body.recommended).toMatch(/stake/i);
  });

  it('proceeds to settlement (200) when authorized', async () => {
    const res = await request(app)
      .post(`/api/v1/x402/${UUID}/trade-analysis`)
      .set('X-PAYMENT', 'dummy-header');
    expect(res.status).toBe(200);
    expect((global as any).__settleCalled).toBe(true);
    expect(res.body.status).toBe('success');
  });
});

describe('POST /api/v1/x402/:uuid/trade-analysis — self-dealing guard (Task 3)', () => {
  it('402s self_dealing_forbidden when payer wallet == payee wallet and never settles', async () => {
    (global as any).__inboundAgentRow.wallet_address = '0xSAME';
    (global as any).__inboundVerify = { valid: true, payer: '0xsame' }; // case-insensitive match
    const res = await request(app)
      .post(`/api/v1/x402/${UUID}/trade-analysis`)
      .set('X-PAYMENT', 'dummy-header');
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('self_dealing_forbidden');
    expect(res.body.failure_class).toBe('PERMANENT');
    expect((global as any).__settleCalled).toBe(false);
  });
});
