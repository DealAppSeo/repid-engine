/**
 * Multi-token advisory slice — registry + equivalence + human policy. Advisory and
 * read-only: nothing here builds a tx, reads a chain, or moves funds, and these
 * tests assert exactly that honesty, not a quote.
 *
 * No address literal is typed in this file — every address assertion reads the
 * registry's own exported value. That keeps a public contract address out of the
 * test corpus (the gitleaks lesson from #1261) and makes the test track the source.
 */

import {
  BASE_SEPOLIA_TOKENS,
  getToken,
  isTransferReady,
  listTokens,
  transferReadySymbols,
} from '../src/services/token-registry';
import {
  convertAmount,
  commonSettlementTokens,
  rankByTransferCost,
} from '../src/services/token-equivalence';
import {
  checkAcceptedToken,
  effectiveAcceptedTokens,
  DEFAULT_ACCEPTED,
} from '../src/services/accepted-tokens-policy';

describe('token-registry — honest per-address confidence', () => {
  it('known VERIFIED tokens resolve case-insensitively; unknown returns null', () => {
    expect(getToken('usdc')?.symbol).toBe('USDC');
    expect(getToken('  EuRc ')?.symbol).toBe('EURC');
    expect(getToken('DOGE')).toBeNull();
    expect(getToken(42 as unknown)).toBeNull();
  });

  it('every VERIFIED ERC-20 address is well-formed; native ETH has no contract', () => {
    for (const t of listTokens()) {
      if (t.confidence !== 'VERIFIED') continue;
      if (t.symbol === 'ETH') {
        expect(t.address).toBeNull();
      } else {
        expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  it('cbBTC stays NOT_CHECKED — an unconfirmed address is never dressed as verified', () => {
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.confidence).toBe('NOT_CHECKED');
    // It is still LISTED (not silently dropped) and carries a candidate address...
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // ...but it is NOT transfer-ready, so it can never be the leg of a real send.
    expect(isTransferReady(getToken('cbBTC'))).toBe(false);
  });

  it('isTransferReady gates on VERIFIED; transferReadySymbols excludes NOT_CHECKED', () => {
    expect(isTransferReady(getToken('USDC'))).toBe(true);
    expect(isTransferReady(getToken('ETH'))).toBe(true); // native
    expect(isTransferReady(null)).toBe(false);
    const ready = transferReadySymbols();
    expect(ready).toEqual(expect.arrayContaining(['USDC', 'EURC', 'WETH', 'ETH']));
    expect(ready).not.toContain('cbBTC');
  });
});

describe('convertAmount — price honesty (a rate we did not verify never reads firm)', () => {
  it('no price => NOT_CHECKED, not 1:1 and not a failure', () => {
    const r = convertAmount('USDC', 'EURC', 5_000_000n);
    expect(r.status).toBe('NOT_CHECKED');
    expect(r.toAmount).toBeNull();
    expect(r.priceVerified).toBe(false);
    expect(r.applied).toBe(false);
  });

  it('caller price => ADVISORY, exact arithmetic, stamped unverified + caller-supplied', () => {
    // 5 USDC at 0.92 EURC/USDC = 4.6 EURC (both 6dp). Exact, no remainder.
    const r = convertAmount('USDC', 'EURC', 5_000_000n, { num: 92n, den: 100n });
    expect(r.status).toBe('ADVISORY');
    expect(r.toAmount).toBe('4600000');
    expect(r.floored).toBe(false);
    expect(r.priceSource).toBe('caller_supplied');
    expect(r.priceVerified).toBe(false);
  });

  it('handles differing decimals (USDC 6dp -> WETH 18dp) exactly', () => {
    // 1 USDC at 0.0005 WETH/USDC = 0.0005 WETH = 5e14 wei.
    const r = convertAmount('USDC', 'WETH', 1_000_000n, { num: 1n, den: 2000n });
    expect(r.status).toBe('ADVISORY');
    expect(r.toAmount).toBe('500000000000000');
  });

  it('reports a floored result rather than silently rounding', () => {
    // 1 USDC at 1/3 EURC/USDC = 0.333333... -> floor 0.333333 EURC, remainder dropped.
    const r = convertAmount('USDC', 'EURC', 1_000_000n, { num: 1n, den: 3n });
    expect(r.toAmount).toBe('333333');
    expect(r.floored).toBe(true);
  });

  it('refuses unknown tokens, negative amounts, and a non-positive denominator', () => {
    expect(convertAmount('DOGE', 'USDC', 1n).status).toBe('REFUSED');
    expect(convertAmount('USDC', 'DOGE', 1n).status).toBe('REFUSED');
    expect(convertAmount('USDC', 'EURC', -1n).status).toBe('REFUSED');
    expect(convertAmount('USDC', 'EURC', 1n, { num: 1n, den: 0n }).status).toBe('REFUSED');
  });
});

describe('commonSettlementTokens — pure, no price, NOT_CHECKED excluded', () => {
  it('intersects transfer-ready tokens and surfaces the stable ones', () => {
    const r = commonSettlementTokens(['USDC', 'EURC', 'cbBTC'], ['EURC', 'cbBTC', 'WETH']);
    // cbBTC is NOT_CHECKED, so it is never offered as common ground even though both list it.
    expect(r.common).toEqual(['EURC']);
    expect(r.stableCommon).toEqual(['EURC']);
    expect(r.none).toBe(false);
  });

  it('reports none when the parties share no transfer-ready token', () => {
    const r = commonSettlementTokens(['USDC'], ['WETH']);
    expect(r.common).toEqual([]);
    expect(r.none).toBe(true);
  });
});

describe('rankByTransferCost — relative heuristic, absolute cost NOT_CHECKED', () => {
  it('native ETH is cheapest; NOT_CHECKED tokens are excluded; absolute cost unverified', () => {
    const r = rankByTransferCost(['ETH', 'USDC', 'EURC', 'cbBTC']);
    expect(r.cheapest).toBe('ETH');
    expect(r.ranked.map((e) => e.symbol)).not.toContain('cbBTC');
    expect(r.absoluteCostVerified).toBe(false);
    expect(r.estimateBasis).toBe('heuristic_gas_units');
    // ERC-20s tie on gas units -> alphabetical, deterministic.
    expect(r.ranked.map((e) => e.symbol)).toEqual(['ETH', 'EURC', 'USDC']);
  });
});

describe('accepted-tokens-policy — the human gate, fail-closed', () => {
  it('no policy set => USDC-only default (today\'s single-token behaviour)', () => {
    expect(DEFAULT_ACCEPTED).toEqual(['USDC']);
    const usdc = checkAcceptedToken('USDC');
    expect(usdc.decision).toBe('ACCEPTED');
    expect(usdc.reason).toBe('default_usdc_only');
    expect(usdc.usedDefault).toBe(true);
    // EURC is a fine token, but the human has not opted into it yet.
    expect(checkAcceptedToken('EURC').decision).toBe('REFUSED');
    expect(checkAcceptedToken('EURC').reason).toBe('not_in_policy');
  });

  it('an explicit list accepts exactly what the human permitted', () => {
    const policy = { accept: ['USDC', 'EURC'] };
    expect(checkAcceptedToken('usdc', policy).decision).toBe('ACCEPTED');
    expect(checkAcceptedToken('EURC', policy).reason).toBe('in_policy');
    expect(checkAcceptedToken('WETH', policy).decision).toBe('REFUSED');
  });

  it('unknown token and a listed-but-NOT_CHECKED token are both refused', () => {
    expect(checkAcceptedToken('DOGE', { accept: ['DOGE'] }).reason).toBe('unknown_token');
    // Even if the human lists cbBTC, its address is unverified -> refused.
    const cb = checkAcceptedToken('cbBTC', { accept: ['cbBTC'] });
    expect(cb.decision).toBe('REFUSED');
    expect(cb.reason).toBe('address_not_verified');
  });

  it('an explicit empty list means accept nothing — distinct from no policy', () => {
    const r = checkAcceptedToken('USDC', { accept: [] });
    expect(r.decision).toBe('REFUSED');
    expect(r.reason).toBe('policy_accepts_nothing');
    expect(effectiveAcceptedTokens({ accept: [] })).toEqual([]);
    // No policy at all still falls back to USDC.
    expect(effectiveAcceptedTokens()).toEqual(['USDC']);
    // A listed NOT_CHECKED token is dropped from the effective set.
    expect(effectiveAcceptedTokens({ accept: ['USDC', 'cbBTC'] })).toEqual(['USDC']);
  });
});
