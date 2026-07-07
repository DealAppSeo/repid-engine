import { settleX402Payment, BASE_SEPOLIA_TOKENS } from '../src/services/x402-real-settler';
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
            limit: jest.fn().mockResolvedValue({ data: [] }),
            // circuit-breaker guard reads cb_disable_x402_settlements → off (null)
            maybeSingle: jest.fn().mockResolvedValue({ data: null })
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

  // -------------------------------------------------------------------------
  // Multi-token settlement + graceful fallback
  // -------------------------------------------------------------------------

  it('default (USDC) still settles and records USDC token/address', async () => {
    const mockWait = jest.fn().mockResolvedValue({});
    const mockTransfer = jest.fn().mockResolvedValue({ hash: '0xusdc', wait: mockWait });
    const mockBalanceOf = jest.fn().mockResolvedValue(10_000_000n); // 10 USDC

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      balanceOf: mockBalanceOf,
      transfer: mockTransfer,
    }));
    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({ address: '0xmockaddress' }));

    // No explicit token arg → defaults to USDC
    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_usdc');

    expect(result.settlement_source).toBe('onchain_x402');
    expect(result.tx_hash).toBe('0xusdc');
    expect(result.token).toBe('USDC');
    expect(result.token_address).toBe(BASE_SEPOLIA_TOKENS.USDC.address);
  });

  it('settles in an alternate token when USDC is short and accept_alternate is set', async () => {
    const usdcAddr = BASE_SEPOLIA_TOKENS.USDC.address;
    const cbBtcAddr = BASE_SEPOLIA_TOKENS.cbBTC.address;

    const cbBtcTransfer = jest.fn().mockResolvedValue({ hash: '0xcbbtc', wait: jest.fn().mockResolvedValue({}) });

    // Route balances/transfer by the contract address passed to the ctor.
    (ethers.Contract as jest.Mock).mockImplementation((addr: string) => {
      if (addr === usdcAddr) {
        return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
      }
      if (addr === cbBtcAddr) {
        // 1 cbBTC (8 decimals) — enough to cover amount 1
        return { balanceOf: jest.fn().mockResolvedValue(100_000_000n), transfer: cbBtcTransfer };
      }
      // EURC and anything else: zero
      return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
    });
    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({ address: '0xmockaddress' }));

    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_alt', 'USDC', { accept_alternate: true });

    expect(result.settlement_source).toBe('onchain_x402');
    expect(result.token).toBe('cbBTC');
    expect(result.token_address).toBe(cbBtcAddr);
    expect(result.tx_hash).toBe('0xcbbtc');
    expect(cbBtcTransfer).toHaveBeenCalled();
  });

  it('no balance in requested token → fallback list of what it DOES hold', async () => {
    const usdcAddr = BASE_SEPOLIA_TOKENS.USDC.address;
    const cbBtcAddr = BASE_SEPOLIA_TOKENS.cbBTC.address;

    (ethers.Contract as jest.Mock).mockImplementation((addr: string) => {
      if (addr === usdcAddr) {
        return { balanceOf: jest.fn().mockResolvedValue(0n) };
      }
      if (addr === cbBtcAddr) {
        return { balanceOf: jest.fn().mockResolvedValue(42n) }; // holds a little cbBTC
      }
      return { balanceOf: jest.fn().mockResolvedValue(0n) };
    });
    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({ address: '0xmockaddress' }));
    // Native ETH balance lookup via provider.getBalance
    (ethers.JsonRpcProvider as unknown as jest.Mock).mockImplementation(() => ({
      getBalance: jest.fn().mockResolvedValue(0n),
    }));

    // accept_alternate NOT set → return fallback report, no settlement
    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_nobal', 'USDC');

    expect(result.settlement_source).toBe('pending_funding');
    expect(result.error).toContain('Insufficient USDC');
    expect(result.next_step).toBeTruthy();
    expect(Array.isArray(result.tokens_held)).toBe(true);
    const symbols = (result.tokens_held || []).map((t) => t.token);
    expect(symbols).toContain('cbBTC');
    expect(symbols).not.toContain('USDC'); // zero balance excluded
  });

  it('unsupported token → clear reject', async () => {
    const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_bad', 'DOGE');
    expect(result.settlement_source).toBe('pending_funding');
    expect(result.error).toContain("Unsupported token 'DOGE'");
    expect(result.error).toContain('USDC');
  });
});
