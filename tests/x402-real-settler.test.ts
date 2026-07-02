import { settleX402Payment } from '../src/services/x402-real-settler';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('ethers');
jest.mock('@supabase/supabase-js');

describe('x402-real-settler', () => {
  beforeEach(() => {
    process.env.APM_PRIVATE_KEY = '0x123';
    process.env.VERITAS_PRIVATE_KEY = '0x456';
    
    // Chainable mock covering both the real path (.select().eq().limit()) and the
    // MOCK_FACILITATOR path (.select().eq().maybeSingle(), .insert()).
    const makeChain = (): any => {
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        limit: jest.fn().mockResolvedValue({ data: [] }),
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
        insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      return chain;
    };
    (createClient as jest.Mock).mockReturnValue({
      from: jest.fn(() => makeChain()),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('handles happy path correctly', async () => {
    const mockWait = jest.fn().mockResolvedValue({});
    const mockTransfer = jest.fn().mockResolvedValue({
      hash: '0xdef',
      wait: mockWait
    });
    
    const mockBalanceOf = jest.fn().mockResolvedValue(10000000n); // 10 USDC

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      balanceOf: mockBalanceOf,
      transfer: mockTransfer
    }));

    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({
      address: '0xmockaddress'
    }));

    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_123');

    expect(result.settlement_source).toBe('onchain_x402');
    expect(result.tx_hash).toBe('0xdef');
    expect(result.basescan_url).toContain('0xdef');
    // Task 2: a real on-chain transfer must flag is_real_settlement=true.
    expect(result.is_real_settlement).toBe(true);
  });

  it('returns pending_funding if balance is zero or insufficient', async () => {
    const mockBalanceOf = jest.fn().mockResolvedValue(500000n); // 0.5 USDC

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      balanceOf: mockBalanceOf
    }));

    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_123'); // wants 1 USDC
    
    expect(result.settlement_source).toBe('pending_funding');
  });

  it('returns pending_funding on contract revert', async () => {
    const mockBalanceOf = jest.fn().mockResolvedValue(10000000n); // 10 USDC
    const mockTransfer = jest.fn().mockRejectedValue(new Error('execution reverted'));

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      balanceOf: mockBalanceOf,
      transfer: mockTransfer
    }));

    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_123');
    
    expect(result.settlement_source).toBe('pending_funding');
    expect(result.error).toContain('execution reverted');
  });

  it('returns pending_funding if missing private key', async () => {
    delete process.env.APM_PRIVATE_KEY;
    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_123');
    expect(result.settlement_source).toBe('pending_funding');
    expect(result.error).toContain('Missing private key');
  });

  // Task 2 — every response carries is_real_settlement; mocks are honest + loud.
  describe('is_real_settlement flag (Task 2)', () => {
    it('non-real paths (pending_funding) flag is_real_settlement=false', async () => {
      const mockBalanceOf = jest.fn().mockResolvedValue(500000n); // 0.5 USDC < 1
      (ethers.Contract as jest.Mock).mockImplementation(() => ({ balanceOf: mockBalanceOf }));
      const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_flag');
      expect(result.settlement_source).toBe('pending_funding');
      expect(result.is_real_settlement).toBe(false);
    });

    it('MOCK_FACILITATOR settlements flag is_real_settlement=false and warn loudly', async () => {
      const prev = process.env.MOCK_FACILITATOR;
      process.env.MOCK_FACILITATOR = 'true';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await settleX402Payment('APM', 'VERITAS', 0.5, 'bet_mock');
        expect(result.settlement_source).toBe('onchain_x402');
        expect(result.tx_hash).toMatch(/^0xmock/);
        expect(result.is_real_settlement).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toMatch(/SIMULATED|is_real_settlement=false/i);
      } finally {
        warnSpy.mockRestore();
        if (prev === undefined) delete process.env.MOCK_FACILITATOR;
        else process.env.MOCK_FACILITATOR = prev;
      }
    });
  });
});
