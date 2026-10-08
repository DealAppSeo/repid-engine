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

  it('cbBTC is VERIFIED — promoted only after a direct on-chain read, with the source recorded', () => {
    // Promoted 2026-10-08 after an eth_call on Base Sepolia: symbol()=="cbBTC",
    // decimals()==8, chainId==84532. The promotion gate did its job — it stayed
    // NOT_CHECKED until the address was proven, not until it looked plausible.
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.confidence).toBe('VERIFIED');
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.decimals).toBe(8);
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The `source` field must record WHERE it was verified, so the claim is auditable.
    expect(BASE_SEPOLIA_TOKENS.cbBTC?.source).toMatch(/on-chain/i);
    // Now VERIFIED, it is transfer-ready — it can be the leg of a real send.
    expect(isTransferReady(getToken('cbBTC'))).toBe(true);
  });

  it('isTransferReady gates on VERIFIED; a non-VERIFIED or null token is never ready', () => {
    expect(isTransferReady(getToken('USDC'))).toBe(true);
    expect(isTransferReady(getToken('ETH'))).toBe(true); // native
    expect(isTransferReady(null)).toBe(false);
    // A token the registry does not know is never transfer-ready.
    expect(isTransferReady(getToken('DOGE'))).toBe(false);
    const ready = transferReadySymbols();
    expect(ready).toEqual(expect.arrayContaining(['USDC', 'EURC', 'WETH', 'ETH', 'cbBTC']));
    // The gate still fail-closes: a hand-built NOT_CHECKED token is refused even with a
    // well-formed address — proven address, not plausible address, is the bar.
    expect(
      isTransferReady({
        symbol: 'FAKE',
        name: 'unconfirmed',
        address: '0x' + '9'.repeat(40),
        decimals: 18,
        confidence: 'NOT_CHECKED',
        volatility: 'volatile',
        source: 'hand-built, never verified',
      }),
    ).toBe(false);
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
    // Both parties list EURC and cbBTC; both are now transfer-ready, so both are common.
    expect(r.common).toEqual(['EURC', 'cbBTC']);
    // ...but only EURC is fiat-stable. cbBTC is volatile, so it is NOT surfaced as a
    // safe (exchange-rate-free) settlement — stableCommon is the safer proposal.
    expect(r.stableCommon).toEqual(['EURC']);
    expect(r.none).toBe(false);
  });

  it('a NOT_CHECKED token (if any) is never offered as common ground even if both list it', () => {
    // No registry token is NOT_CHECKED today, so this pins the GATE, not a specific token:
    // an unknown symbol both parties "accept" resolves to nothing, so there is no common
    // ground to settle on. Proven-and-known is the bar, not listed-by-both.
    const r = commonSettlementTokens(['USDC', 'DOGE'], ['DOGE', 'WETH']);
    expect(r.common).toEqual([]);
    expect(r.none).toBe(true);
  });

  it('reports none when the parties share no transfer-ready token', () => {
    const r = commonSettlementTokens(['USDC'], ['WETH']);
    expect(r.common).toEqual([]);
    expect(r.none).toBe(true);
  });
});

describe('rankByTransferCost — relative heuristic, absolute cost NOT_CHECKED', () => {
  it('native ETH is cheapest; unknown tokens are excluded; absolute cost unverified', () => {
    // DOGE is unknown to the registry, so it drops out — only transfer-ready tokens rank.
    const r = rankByTransferCost(['ETH', 'USDC', 'EURC', 'cbBTC', 'DOGE']);
    expect(r.cheapest).toBe('ETH');
    expect(r.ranked.map((e) => e.symbol)).not.toContain('DOGE');
    expect(r.absoluteCostVerified).toBe(false);
    expect(r.estimateBasis).toBe('heuristic_gas_units');
    // Native ETH first (21k gas); the ERC-20s tie on gas units -> alphabetical by
    // localeCompare, deterministic. cbBTC is now VERIFIED, so it is in the ranking.
    expect(r.ranked.map((e) => e.symbol)).toEqual(['ETH', 'cbBTC', 'EURC', 'USDC']);
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

  it('an unknown token is refused even if the human lists it; a VERIFIED one is accepted', () => {
    // A symbol not in the registry is never accepted on faith — an attacker cannot smuggle
    // in a look-alike by putting it in the policy.
    expect(checkAcceptedToken('DOGE', { accept: ['DOGE'] }).reason).toBe('unknown_token');
    // cbBTC is now VERIFIED (promoted 2026-10-08), so a human who lists it CAN accept it.
    const cb = checkAcceptedToken('cbBTC', { accept: ['USDC', 'cbBTC'] });
    expect(cb.decision).toBe('ACCEPTED');
    expect(cb.reason).toBe('in_policy');
  });

  it('the address-not-verified gate still fail-closes for a NOT_CHECKED token', () => {
    // No registry token is NOT_CHECKED today, so DOGE (unknown) is the live refusal a human
    // would hit. The address_not_verified branch stays in the policy for any FUTURE token
    // added as NOT_CHECKED — it is covered by token-registry's isTransferReady gate, which
    // this suite pins directly above. Listing an unknown token never silently succeeds.
    expect(checkAcceptedToken('DOGE', { accept: ['USDC', 'DOGE'] }).decision).toBe('REFUSED');
  });

  it('an explicit empty list means accept nothing — distinct from no policy', () => {
    const r = checkAcceptedToken('USDC', { accept: [] });
    expect(r.decision).toBe('REFUSED');
    expect(r.reason).toBe('policy_accepts_nothing');
    expect(effectiveAcceptedTokens({ accept: [] })).toEqual([]);
    // No policy at all still falls back to USDC.
    expect(effectiveAcceptedTokens()).toEqual(['USDC']);
    // cbBTC is now VERIFIED, so a human who lists it keeps it in the effective set.
    expect(effectiveAcceptedTokens({ accept: ['USDC', 'cbBTC'] })).toEqual(['USDC', 'cbBTC']);
    // An unknown symbol is still dropped — only known, transfer-ready tokens survive.
    expect(effectiveAcceptedTokens({ accept: ['USDC', 'DOGE'] })).toEqual(['USDC']);
  });
});
