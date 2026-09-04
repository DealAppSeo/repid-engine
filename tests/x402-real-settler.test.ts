import {
  settleX402Payment,
  governorCeilingFor,
  BASE_SEPOLIA_TOKENS,
  settleableTokenSymbols,
  isSettleableToken,
  UNCONFIRMED_TOKEN_ADDRESS,
} from '../src/services/x402-real-settler';
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

  const REAL_ADDRESSES = Object.fromEntries(
    Object.entries(BASE_SEPOLIA_TOKENS).map(([k, v]) => [k, v.address])
  );

  afterEach(() => {
    jest.clearAllMocks();
    // Undo any per-test address confirmation, so a test that pretends a
    // placeholder is confirmed cannot leak that into the next one.
    for (const [k, addr] of Object.entries(REAL_ADDRESSES)) {
      BASE_SEPOLIA_TOKENS[k]!.address = addr as string;
    }
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

  // ── THESE TWO TESTS USED TO ASSERT THE DEFECT [corrected 2026-09-04] ──────
  // Both exercise the alternate-token fallback using cbBTC, whose address in the
  // map is the ZERO ADDRESS (`TODO(review): confirm Base Sepolia address`). They
  // mock `ethers.Contract` by address, so the mock cheerfully gave 0x0…0 a
  // healthy balance — and the first one then asserted `token_address` was that
  // zero address and that a transfer had been CALLED against it. Green, and
  // pinning a settlement into an unconfigured token as correct behaviour.
  //
  // The fallback rule they cover is real and worth testing. The token they used
  // to cover it was not, so each now confirms cbBTC's address for the duration
  // of the test — the state the TODO is waiting for — and the placeholder
  // behaviour is asserted separately below.
  const CONFIRMED_STANDIN = '0x1111111111111111111111111111111111111111';

  it('settles in an alternate token when USDC is short and accept_alternate is set', async () => {
    const usdcAddr = BASE_SEPOLIA_TOKENS.USDC.address;
    BASE_SEPOLIA_TOKENS.cbBTC!.address = CONFIRMED_STANDIN;
    const cbBtcAddr = BASE_SEPOLIA_TOKENS.cbBTC!.address;

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
    BASE_SEPOLIA_TOKENS.cbBTC!.address = CONFIRMED_STANDIN;
    const cbBtcAddr = BASE_SEPOLIA_TOKENS.cbBTC!.address;

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

  // ── UNCONFIRMED TOKEN ADDRESSES MUST FAIL CLOSED ──────────────────────────
  //
  // `cbBTC` and `EURC` are declared with the zero address. Being map keys made
  // them SUPPORTED to every caller: the requested-token gate checked key
  // existence only, so a request to settle in cbBTC passed it, and the
  // "Unsupported token" message listed both back to the caller as available.
  //
  // The alternate fallback never picked them, but only because there is no
  // contract at the zero address — so `balanceOf` throws (skipped by a bare
  // catch) or returns 0 (rejected by the balance test). Those are properties of
  // the chain, not decisions this code makes. These pin the decisions.
  describe('unconfirmed token addresses', () => {
    it('cbBTC and EURC are still placeholders (this test retires itself)', () => {
      // If someone confirms an address, this fails and the entry should simply
      // be removed from the list — that is the intended way for this to end.
      expect(BASE_SEPOLIA_TOKENS.cbBTC!.address).toBe(UNCONFIRMED_TOKEN_ADDRESS);
      expect(BASE_SEPOLIA_TOKENS.EURC!.address).toBe(UNCONFIRMED_TOKEN_ADDRESS);
    });

    it('classifies placeholders as unsettleable and real tokens as settleable', () => {
      expect(isSettleableToken(BASE_SEPOLIA_TOKENS.USDC!)).toBe(true);
      expect(isSettleableToken(BASE_SEPOLIA_TOKENS.ETH!)).toBe(true); // native sentinel, not a placeholder
      expect(isSettleableToken(BASE_SEPOLIA_TOKENS.cbBTC!)).toBe(false);
      expect(isSettleableToken(BASE_SEPOLIA_TOKENS.EURC!)).toBe(false);
    });

    it('never advertises a token it cannot settle', () => {
      const advertised = settleableTokenSymbols();
      expect(advertised).toContain('USDC');
      expect(advertised).not.toContain('cbBTC');
      expect(advertised).not.toContain('EURC');
    });

    it('refuses a request for a placeholder token, as a config gap not a bad request', async () => {
      const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_ph', 'cbBTC');
      expect(result.settlement_source).toBe('pending_funding');
      expect(result.error).toMatch(/unconfirmed/i);
      // And it must not point the caller at another token that cannot settle.
      expect(result.error).not.toMatch(/EURC/);
    });

    it('the unsupported-token message lists only settleable tokens', async () => {
      const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_bad2', 'DOGE');
      expect(result.error).toContain('USDC');
      expect(result.error).not.toContain('cbBTC');
      expect(result.error).not.toContain('EURC');
    });

    it('never chooses a placeholder as the alternate, even holding plenty of it', async () => {
      // The decisive case: the chain's accidental guard is removed by giving the
      // zero address a huge balance. Only an explicit skip can refuse it now.
      const usdcAddr = BASE_SEPOLIA_TOKENS.USDC.address;
      const transferAtZero = jest.fn();
      (ethers.Contract as jest.Mock).mockImplementation((addr: string) => {
        if (addr === usdcAddr) {
          return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
        }
        if (addr === UNCONFIRMED_TOKEN_ADDRESS) {
          return {
            balanceOf: jest.fn().mockResolvedValue(10n ** 18n), // plenty
            transfer: transferAtZero,
          };
        }
        return { balanceOf: jest.fn().mockResolvedValue(0n), transfer: jest.fn() };
      });
      (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => ({ address: '0xmockaddress' }));
      (ethers.JsonRpcProvider as unknown as jest.Mock).mockImplementation(() => ({
        getBalance: jest.fn().mockResolvedValue(0n),
      }));

      const result = await settleX402Payment('APM', 'VERITAS', 1, 'bet_noph', 'USDC', {
        accept_alternate: true,
      });

      expect(result.settlement_source).toBe('pending_funding');
      expect(result.token_address).not.toBe(UNCONFIRMED_TOKEN_ADDRESS);
      // The assertion that matters: no money moved to the zero address.
      expect(transferAtZero).not.toHaveBeenCalled();
      // And it is not reported as a holding either.
      expect((result.tokens_held || []).map((t) => t.token)).not.toContain('cbBTC');
    });
  });

  // ── THE AMOUNT GOVERNOR WAS UNIT-BLIND ────────────────────────────────────
  //
  // Both guards read `if (amountUSDC > 1.0)` and answered "max amount is 1.0
  // USDC" — but `amountUSDC` is a bare number and this function takes a `token`
  // argument, so the comparison ignored the asset entirely. 0.9 ETH sailed
  // through a ceiling whose name, message and intent are all dollar-denominated.
  //
  // Nothing exercised it (neither existing caller of the ETH-capable path passes
  // 'ETH'), so it was a live trap rather than a live loss. These pin it shut
  // before the native leg is used, which is the whole point of fixing it now.
  describe('amount governor is per-asset, not a bare float', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.MOCK_FACILITATOR = 'true'; // governor runs before any chain work
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it('declares a ceiling in each asset OWN units, and refuses undeclared assets', () => {
      expect(governorCeilingFor('USDC')).toBe(1.0); // unchanged
      expect(governorCeilingFor('ETH')).toBe(0.001);
      // Fail closed: adding a token to the map cannot silently inherit a dollar
      // limit that means nothing for it.
      expect(governorCeilingFor('cbBTC')).toBeNull();
      expect(governorCeilingFor('WHATEVER')).toBeNull();
    });

    it('REFUSES 0.9 ETH — the exact amount the unit-blind check let through', async () => {
      const r = await settleX402Payment('APM', 'VERITAS', 0.9, 'bet_eth_big', 'ETH');
      expect(r.settlement_source).toBe('pending_funding');
      expect(r.error).toMatch(/Governor limit exceeded/);
      // The message must name the real asset and ceiling, not "1.0 USDC".
      expect(r.error).toMatch(/0\.001 ETH/);
      expect(r.error).not.toMatch(/USDC/);
    });

    it('allows a small native transfer — 0.0001 ETH is under the ETH ceiling', async () => {
      const r = await settleX402Payment('APM', 'VERITAS', 0.0001, 'bet_eth_small', 'ETH');
      // It must get PAST the governor. Whatever it fails on afterwards (no key,
      // no chain in this env) is not the governor's refusal.
      expect(r.error ?? '').not.toMatch(/Governor/);
    });

    it('leaves the USDC ceiling exactly where it was', async () => {
      const over = await settleX402Payment('APM', 'VERITAS', 1.5, 'bet_usdc_over', 'USDC');
      expect(over.error).toMatch(/Governor limit exceeded: max amount is 1 USDC/);
      const under = await settleX402Payment('APM', 'VERITAS', 0.5, 'bet_usdc_under', 'USDC');
      expect(under.error ?? '').not.toMatch(/Governor/);
    });

    it('the ceiling is policy, so it is env-overridable', () => {
      process.env.X402_GOVERNOR_MAX_ETH = '0.05';
      expect(governorCeilingFor('ETH')).toBe(0.05);
      // A nonsense override falls back rather than disabling the guard.
      process.env.X402_GOVERNOR_MAX_ETH = 'not-a-number';
      expect(governorCeilingFor('ETH')).toBe(0.001);
      process.env.X402_GOVERNOR_MAX_ETH = '-5';
      expect(governorCeilingFor('ETH')).toBe(0.001);
    });
  });
});
