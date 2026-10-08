/**
 * Two agents negotiating a token exchange — the ADVISORY flow, end to end, with the
 * real merged helpers (token-registry, token-equivalence, accepted-tokens-policy).
 *
 * WHAT THIS IS: agents PROPOSE a settlement — convert, find a token both accept, rank
 * cheapest-to-move — under each human's allowed-token policy. It is read-only and moves
 * no funds: there is no DEX/swap execution wired yet, so "exchange" here means "agree how
 * to settle", not "broadcast a swap". The console narration below is a transcript of what
 * an agent can honestly offer today; the assertions lock the honest behaviour in.
 *
 * WHY IT MATTERS: every edge an attacker would push on a multi-token settlement is closed
 * here — a token outside the human's policy is refused, an UNKNOWN token (a look-alike
 * symbol not in the registry) is refused even if a human lists it, and a cross-token value
 * with no verified price reads NOT_CHECKED (never a made-up rate). No env, no DB, no chain.
 * (cbBTC was promoted to VERIFIED on 2026-10-08 after a direct on-chain read, so it is now
 * an acceptable settlement token — EXCHANGE 5 shows both the refusal and the acceptance.)
 */

import { commonSettlementTokens, convertAmount, rankByTransferCost } from '../../src/services/token-equivalence';
import { checkAcceptedToken } from '../../src/services/accepted-tokens-policy';

// Two agents, each with the token policy its human set.
const SOPHIA = { name: 'trinity-sophia', policy: { accept: ['USDC', 'EURC'] } };
const NEXUS = { name: 'trinity-nexus', policy: { accept: ['USDC', 'WETH'] } };

const log = (s: string) => console.log(s); // narration; jest surfaces it

describe('agent token exchange — advisory negotiation between two agents', () => {
  it('EXCHANGE 1: both already accept USDC → settle in USDC, no price needed', () => {
    log(`\n[${SOPHIA.name}] I need to pay [${NEXUS.name}]. Which token do we both accept?`);
    const common = commonSettlementTokens(SOPHIA.policy.accept, NEXUS.policy.accept);
    log(`  → common transfer-ready tokens: ${JSON.stringify(common.common)}  (stable: ${JSON.stringify(common.stableCommon)})`);
    // USDC is accepted by both and is stable → the safest settlement, no exchange rate at all.
    expect(common.common).toEqual(['USDC']);
    expect(common.stableCommon).toEqual(['USDC']);
    expect(common.none).toBe(false);
    log(`  → PROPOSE: settle in USDC. It is a shared, stable token — a verifiable fact, not a quote.`);
  });

  it('EXCHANGE 2: NEXUS offers WETH, but SOPHIA\'s human did not allow WETH → refused, fall back to USDC', () => {
    log(`\n[${NEXUS.name}] I'd like to pay you in WETH.`);
    const check = checkAcceptedToken('WETH', SOPHIA.policy);
    log(`  → SOPHIA policy check on WETH: ${check.decision} (${check.reason})`);
    expect(check.decision).toBe('REFUSED');
    expect(check.reason).toBe('not_in_policy'); // the human's settings gate it, not the agent
    const common = commonSettlementTokens(SOPHIA.policy.accept, NEXUS.policy.accept);
    log(`  → PROPOSE instead: ${common.common[0]} (the token both humans permit).`);
    expect(common.common).toContain('USDC');
  });

  it('EXCHANGE 3: cross-token value — honest about price (NOT_CHECKED without an oracle, ADVISORY with a caller rate)', () => {
    log(`\n[${SOPHIA.name}] If we must cross tokens, what is 50 USDC worth in EURC?`);
    const noPrice = convertAmount('USDC', 'EURC', 50_000_000n); // 50 USDC (6dp), no price
    log(`  → no verified price oracle is wired → status ${noPrice.status}, amount ${noPrice.toAmount}`);
    expect(noPrice.status).toBe('NOT_CHECKED'); // never a 1:1 guess, never a fabricated rate
    expect(noPrice.toAmount).toBeNull();

    // A party may supply a rate explicitly; the result is ADVISORY and stamped unverified.
    const advisory = convertAmount('USDC', 'EURC', 50_000_000n, { num: 92n, den: 100n }); // 0.92 EURC/USDC
    log(`  → with a CALLER-SUPPLIED 0.92 rate → status ${advisory.status}, ${advisory.toAmount} EURC units, priceVerified=${advisory.priceVerified}`);
    expect(advisory.status).toBe('ADVISORY');
    expect(advisory.toAmount).toBe('46000000'); // 50 * 0.92 = 46 EURC, exact
    expect(advisory.priceVerified).toBe(false);
    expect(advisory.priceSource).toBe('caller_supplied');
  });

  it('EXCHANGE 4: which token is cheapest to move? native ETH < ERC-20 (labeled heuristic)', () => {
    log(`\n[${NEXUS.name}] Of the tokens we could use, which is cheapest to send?`);
    const ranking = rankByTransferCost(['ETH', 'USDC', 'EURC']);
    log(`  → ranked cheapest-first: ${ranking.ranked.map((r) => `${r.symbol}(${r.gasUnits})`).join(', ')}  [basis: ${ranking.estimateBasis}, absoluteCostVerified=${ranking.absoluteCostVerified}]`);
    expect(ranking.cheapest).toBe('ETH'); // native transfer is cheapest by gas units
    expect(ranking.absoluteCostVerified).toBe(false); // gas PRICE not read → relative heuristic only
  });

  it('EXCHANGE 5: an UNKNOWN token is refused even if listed; a VERIFIED cbBTC is accepted', () => {
    // The fail-closed edge: a human cannot opt into a token the registry does not know.
    // Even listed in policy, an unknown symbol is refused — an attacker cannot smuggle a
    // look-alike token onto the wire by naming it in a settings field.
    log(`\n[${NEXUS.name}] Can we settle in DOGE? (my human even added it to my list)`);
    const unknown = checkAcceptedToken('DOGE', { accept: ['USDC', 'DOGE'] });
    log(`  → DOGE policy check: ${unknown.decision} (${unknown.reason})`);
    expect(unknown.decision).toBe('REFUSED');
    expect(unknown.reason).toBe('unknown_token');

    // cbBTC, by contrast, was promoted to VERIFIED on 2026-10-08 after a direct on-chain
    // read (symbol/decimals/chainId). A human who lists it CAN now accept it — the gate
    // opened only because the address was proven, not because it looked plausible.
    const cb = checkAcceptedToken('cbBTC', { accept: ['USDC', 'cbBTC'] });
    log(`  → cbBTC policy check: ${cb.decision} (${cb.reason})`);
    expect(cb.decision).toBe('ACCEPTED');
    expect(cb.reason).toBe('in_policy');
    log(`  → PROPOSE: cbBTC is now a valid settlement leg; DOGE stays off the wire (unknown contract).`);
  });
});
