/**
 * Recipient-address bugfix + DB-custody fallback for x402-real-settler.
 *
 * Uses REAL ethers (so ethers.isAddress / ethers.Wallet behave correctly) but
 * stubs the network pieces (JsonRpcProvider, USDC Contract) and the supabase
 * client. No network is touched.
 */

import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('@supabase/supabase-js');

const REAL_FROM_PK = '0x' + '1'.repeat(64); // valid 32-byte key for APM
const FAKE_ERC8004 = '0xAGENT_deadbeefdeadbeefdeadbeefdeadbeef00'; // not a valid EVM address
const REAL_RECIPIENT = '0x' + '2'.repeat(40); // valid EVM address

// Mutable recipient row the settler's repid_agents lookup returns.
let recipientRow: any = null;

// Configure the supabase mock ONCE (settler memoizes its client), reading the
// mutable recipientRow so each test can vary it.
(createClient as jest.Mock).mockReturnValue({
  from: (table: string) => {
    if (table === 'repid_agents') {
      return {
        select: () => ({
          eq: () => ({
            limit: () => Promise.resolve({ data: recipientRow ? [recipientRow] : [], error: null }),
            // used by the post-settlement recording block
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      };
    }
    // x402_settlements + everything else — benign no-ops
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
      insert: () => Promise.resolve({ data: null, error: null }),
    };
  },
});

import { settleX402Payment } from '../src/services/x402-real-settler';

describe('x402-real-settler recipient resolution', () => {
  let contractSpy: jest.SpyInstance;
  let providerSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.APM_PRIVATE_KEY = REAL_FROM_PK;
    delete process.env.MOCK_FACILITATOR; // exercise the real settlement branch
    delete process.env.VERITAS_PRIVATE_KEY; // recipient has no env key → DB lookup
    recipientRow = null;

    providerSpy = jest.spyOn(ethers, 'JsonRpcProvider').mockImplementation(() => ({}) as any);
    contractSpy = jest.spyOn(ethers, 'Contract').mockImplementation(
      () =>
        ({
          balanceOf: jest.fn().mockResolvedValue(10_000_000n),
          transfer: jest.fn().mockResolvedValue({ hash: '0xok', wait: jest.fn().mockResolvedValue({}) }),
        }) as any
    );
  });

  afterEach(() => {
    contractSpy.mockRestore();
    providerSpy.mockRestore();
  });

  it('BUGFIX: rejects a fake 0xAGENT_ erc8004_address (no valid destination)', async () => {
    recipientRow = { wallet_address: null, erc8004_address: FAKE_ERC8004 };
    const res = await settleX402Payment('APM', 'VERITAS', 0.5, 'bet_fake');
    expect(res.settlement_source).toBe('pending_funding');
    expect(res.error).toContain('Cannot determine destination address');
  });

  it('routes to a valid wallet_address when present', async () => {
    recipientRow = { wallet_address: REAL_RECIPIENT, erc8004_address: FAKE_ERC8004 };
    const res = await settleX402Payment('APM', 'VERITAS', 0.5, 'bet_real');
    expect(res.settlement_source).toBe('onchain_x402');
    expect(res.tx_hash).toBe('0xok');
  });

  it('legacy fallback: uses erc8004_address only if it is a real EVM address', async () => {
    recipientRow = { wallet_address: null, erc8004_address: REAL_RECIPIENT };
    const res = await settleX402Payment('APM', 'VERITAS', 0.5, 'bet_legacy');
    expect(res.settlement_source).toBe('onchain_x402');
  });
});
