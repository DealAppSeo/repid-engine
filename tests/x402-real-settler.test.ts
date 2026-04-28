import { settleX402Payment } from '../src/services/x402-real-settler';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('ethers');
jest.mock('@supabase/supabase-js');

describe('x402-real-settler', () => {
  beforeEach(() => {
    process.env.APM_PRIVATE_KEY = '0x123';
    process.env.VERITAS_PRIVATE_KEY = '0x456';
    
    (createClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({ data: [] })
          })
        })
      })
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
});
