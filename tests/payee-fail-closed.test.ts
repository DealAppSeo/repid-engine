/**
 * E-4 hardening — payee fail-closed.
 *
 * Several payment / x402 / settlement sites resolved a payee with
 * `wallet_address || ZERO` / `?? ZERO`. That does not fail — it quietly
 * advertises, escrows or releases to a BURN as if it were a valid payee. These
 * tests pin the new behaviour: three outcomes, never two. A real payee works; an
 * unset / zero / malformed payee is a REFUSAL, never a silent zero.
 *
 * This file covers the shared guard and the two service-layer sites:
 *   - src/services/payee-guard.ts          (the one definition of "payable")
 *   - src/services/x402-server.ts          (tip flow: createTipRequest / deliverTip)
 *   - src/services/x402-release-retry-worker.ts (releaseFor)
 *
 * The three Express route sites (x402-inbound trade-analysis, contracts escrow
 * and satisfy) are driven through the real app in
 * tests/payee-fail-closed-routes.test.ts.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { ethers } from 'ethers';

// --- mocks shared by the two service-layer sites ---------------------------
// A single mutable repid_agents row the mocked db returns. Prefixed `mock` so
// the hoisted jest.mock factory may reference it.
let mockRepidAgentsRow: any = null;

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: mockRepidAgentsRow, error: null }),
        single: async () => ({ data: mockRepidAgentsRow, error: null }),
        insert: async () => ({ data: null, error: null }),
        update: () => chain,
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/services/audit-emit', () => ({
  emitAuditEvent: jest.fn(async () => ({ audit_chain_id: 1 })),
}));

const mockReleaseHeldPayment = jest.fn(async () => ({ status: 'SETTLED', txHash: '0xok' }));
jest.mock('../src/services/x402-deferred-settlement', () => ({
  ...jest.requireActual('../src/services/x402-deferred-settlement'),
  releaseHeldPayment: (...args: any[]) => mockReleaseHeldPayment(...args),
}));

import {
  isPayableAddress,
  requirePayableAddress,
  PayeeUnsetError,
  ZERO_ADDRESS,
} from '../src/services/payee-guard';
import { createTipRequest, deliverTip } from '../src/services/x402-server';
import { releaseFor } from '../src/services/x402-release-retry-worker';
import type { StrandedContract } from '../src/services/x402-release-retry-worker';

const REAL = '0x2222222222222222222222222222222222222222';
const CHECKSUMMED = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // mixed case, valid EIP-55

// ===========================================================================
describe('payee-guard — the one definition of "payable"', () => {
  it('accepts a real, non-zero address (lower-case or checksummed)', () => {
    expect(isPayableAddress(REAL)).toBe(true);
    expect(isPayableAddress(CHECKSUMMED)).toBe(true);
  });

  it('refuses an unset payee (null / undefined / empty)', () => {
    expect(isPayableAddress(null)).toBe(false);
    expect(isPayableAddress(undefined)).toBe(false);
    expect(isPayableAddress('')).toBe(false);
  });

  it('refuses the zero address — a stored zero is as much a burn as an unset one', () => {
    expect(isPayableAddress(ZERO_ADDRESS)).toBe(false);
    expect(isPayableAddress(ethers.ZeroAddress)).toBe(false);
  });

  it('refuses a malformed / non-address string and non-strings', () => {
    expect(isPayableAddress('0xAGENT_deadbeefdeadbeefdeadbeefdeadbeef00')).toBe(false);
    expect(isPayableAddress('not-an-address')).toBe(false);
    expect(isPayableAddress(42 as unknown)).toBe(false);
    expect(isPayableAddress({} as unknown)).toBe(false);
  });

  it('requirePayableAddress returns the checksummed address for a real payee', () => {
    expect(requirePayableAddress(REAL, 'test')).toBe(ethers.getAddress(REAL));
  });

  it('requirePayableAddress throws PayeeUnsetError (code payee_unset) on unset/zero/invalid', () => {
    for (const bad of [null, undefined, '', ZERO_ADDRESS, '0xnope']) {
      expect(() => requirePayableAddress(bad, 'ctx')).toThrow(PayeeUnsetError);
    }
    try {
      requirePayableAddress(null, 'ctx');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PayeeUnsetError);
      expect(e.code).toBe('payee_unset');
    }
  });
});

// ===========================================================================
describe('x402-server tip flow — fails closed on an unset provider wallet', () => {
  beforeEach(() => {
    mockRepidAgentsRow = { current_repid: 5000, character_score: 1, wallet_address: REAL };
    delete process.env.X402_REAL_RPC;
  });

  it('createTipRequest REFUSES (throws payee_unset) when PROVIDER_AGENT_WALLET is unset', async () => {
    delete process.env.PROVIDER_AGENT_WALLET;
    await expect(
      createTipRequest({ requestor_agent_id: 'r', provider_agent_id: 'p', prediction_topic: 't' }),
    ).rejects.toMatchObject({ code: 'payee_unset' });
  });

  it('createTipRequest REFUSES when PROVIDER_AGENT_WALLET is the zero address', async () => {
    process.env.PROVIDER_AGENT_WALLET = ZERO_ADDRESS;
    await expect(
      createTipRequest({ requestor_agent_id: 'r', provider_agent_id: 'p', prediction_topic: 't' }),
    ).rejects.toBeInstanceOf(PayeeUnsetError);
    delete process.env.PROVIDER_AGENT_WALLET;
  });

  it('createTipRequest advertises the REAL payee when PROVIDER_AGENT_WALLET is set', async () => {
    process.env.PROVIDER_AGENT_WALLET = REAL;
    const r = await createTipRequest({ requestor_agent_id: 'r', provider_agent_id: 'p', prediction_topic: 't' });
    expect(r.status).toBe(402);
    expect(r.body.accepts[0]!.payTo).toBe(REAL);
    expect(r.body.accepts[0]!.payTo).not.toBe(ZERO_ADDRESS);
    delete process.env.PROVIDER_AGENT_WALLET;
  });

  it('deliverTip REFUSES (payee_unset) when PROVIDER_AGENT_WALLET is unset', async () => {
    delete process.env.PROVIDER_AGENT_WALLET;
    const r = await deliverTip({ tipId: 'tip_1', xPaymentHeader: '0xtx' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/payee_unset/);
  });
});

// ===========================================================================
describe('x402-release-retry-worker.releaseFor — never releases to the zero address', () => {
  const stranded: StrandedContract = {
    contractId: 'c-1',
    settlementId: 's-1',
    providerAgentId: 'prov-1',
    agreedPriceRaw: 100000,
    satisfactionScore: 1,
    attempts: 0,
    lastAttemptedAt: null,
  };

  beforeEach(() => {
    mockReleaseHeldPayment.mockClear();
  });

  it('REFUSES (PAYEE_UNSET) and does NOT release when the provider has no wallet', async () => {
    mockRepidAgentsRow = { wallet_address: null };
    const r = await releaseFor(stranded);
    expect(r.status).toBe('PAYEE_UNSET');
    expect(mockReleaseHeldPayment).not.toHaveBeenCalled();
  });

  it('REFUSES when the stored provider wallet is the zero address', async () => {
    mockRepidAgentsRow = { wallet_address: ZERO_ADDRESS };
    const r = await releaseFor(stranded);
    expect(r.status).toBe('PAYEE_UNSET');
    expect(mockReleaseHeldPayment).not.toHaveBeenCalled();
  });

  it('releases to the REAL payee when the provider has a valid wallet', async () => {
    mockRepidAgentsRow = { wallet_address: REAL };
    const r = await releaseFor(stranded);
    expect(mockReleaseHeldPayment).toHaveBeenCalledTimes(1);
    const arg = (mockReleaseHeldPayment.mock.calls[0] as any[])[0];
    expect(arg.requirements[0].payTo).toBe(REAL);
    expect(r.status).toBe('SETTLED');
  });
});
