/**
 * Token equivalence — ADVISORY ONLY. It answers the three questions Sean asked an
 * agent to be able to help with when two parties want to settle in different tokens:
 *
 *   1. "do the math to find the equivalent"      -> convertAmount()
 *   2. "find a common token for the same value"  -> commonSettlementTokens()
 *   3. "find the lowest transfer cost"           -> rankByTransferCost()
 *
 * It computes NOTHING on-chain, moves no funds, and signs nothing. Every result
 * carries `applied: false`.
 *
 * THE PRICE HONESTY RULE, which is the whole point of this module:
 * there is NO verified price oracle wired into this engine today. So a cross-token
 * value conversion has no measured price, and a price we did not measure must never
 * read as a firm number. convertAmount therefore returns:
 *   • status 'NOT_CHECKED' when no price is supplied — we did not look, so we do not
 *     pretend a number. This is NOT the same as "the tokens are worth the same"
 *     (that would be a 1:1 fabrication) and NOT the same as "conversion failed".
 *   • status 'ADVISORY' only when the CALLER supplies a price, and even then the
 *     result is stamped `priceSource: 'caller_supplied'`, `priceVerified: false`.
 *     The arithmetic is ours and exact; the price is the caller's assertion, not
 *     our measurement, and the result says so.
 *
 * This is the anti-exploit edge. An unverified exchange rate presented as a firm
 * quote is exactly how a volatile-token settlement gets gamed; here it cannot be,
 * because the rate always travels with the fact that nobody verified it.
 *
 * commonSettlementTokens needs no price at all — it is pure set logic over the two
 * parties' accepted-token lists, so it is the safest option an agent can propose:
 * "we both already accept USDC" is a verifiable fact, not a quote.
 */

import { getToken, isTransferReady, type BaseSepoliaToken } from './token-registry';

export interface PriceRatio {
  /** Whole units of the quote token per 1 whole unit of the base token. */
  num: bigint;
  den: bigint;
}

export type ConversionStatus = 'ADVISORY' | 'NOT_CHECKED' | 'REFUSED';

export interface ConversionResult {
  status: ConversionStatus;
  from: string;
  to: string;
  /** Input amount, in the FROM token's smallest units (e.g. USDC 6dp). */
  fromAmount: string;
  /** Output amount in the TO token's smallest units — present only when ADVISORY. */
  toAmount: string | null;
  priceSource: 'caller_supplied' | 'none';
  /** Never true today: no verified oracle is wired. */
  priceVerified: false;
  /** True when toAmount was floored (integer division dropped a remainder). */
  floored: boolean;
  applied: false;
  note: string;
}

function refuse(from: string, to: string, fromAmount: bigint, note: string): ConversionResult {
  return {
    status: 'REFUSED',
    from,
    to,
    fromAmount: fromAmount.toString(),
    toAmount: null,
    priceSource: 'none',
    priceVerified: false,
    floored: false,
    applied: false,
    note,
  };
}

/**
 * Convert an amount of one token into the value-equivalent amount of another,
 * decimals-correct, using a CALLER-SUPPLIED price. With no price, returns
 * NOT_CHECKED — never a 1:1 guess and never a fabricated rate.
 *
 * @param fromSymbol base token symbol
 * @param toSymbol   quote token symbol
 * @param fromAmount amount in the FROM token's smallest units (bigint)
 * @param price      optional {num,den}: quote-whole-units per 1 base-whole-unit.
 *                   Omit it to get an honest NOT_CHECKED.
 */
export function convertAmount(
  fromSymbol: string,
  toSymbol: string,
  fromAmount: bigint,
  price?: PriceRatio,
): ConversionResult {
  const from = getToken(fromSymbol);
  const to = getToken(toSymbol);
  if (!from) return refuse(String(fromSymbol), String(toSymbol), fromAmount, `unknown from-token: ${fromSymbol}`);
  if (!to) return refuse(from.symbol, String(toSymbol), fromAmount, `unknown to-token: ${toSymbol}`);
  if (fromAmount < 0n) return refuse(from.symbol, to.symbol, fromAmount, 'amount must be non-negative');

  if (!price) {
    return {
      status: 'NOT_CHECKED',
      from: from.symbol,
      to: to.symbol,
      fromAmount: fromAmount.toString(),
      toAmount: null,
      priceSource: 'none',
      priceVerified: false,
      floored: false,
      applied: false,
      note: 'no verified price oracle is wired; supply a caller price for an ADVISORY estimate. NOT_CHECKED is not 1:1 and is not a failure.',
    };
  }
  if (price.den <= 0n || price.num < 0n) {
    return refuse(from.symbol, to.symbol, fromAmount, 'price ratio must have den>0 and num>=0');
  }

  // value: fromWhole = fromAmount / 10^fromDec
  //        toWhole   = fromWhole * num/den
  //        toAmount  = toWhole * 10^toDec
  //                  = fromAmount * num * 10^toDec / (den * 10^fromDec)
  // Integer math, floor division; we report when it floored.
  const numerator = fromAmount * price.num * 10n ** BigInt(to.decimals);
  const denominator = price.den * 10n ** BigInt(from.decimals);
  const toAmount = numerator / denominator;
  const floored = numerator % denominator !== 0n;

  const crossVolatility = from.volatility !== to.volatility || from.volatility === 'volatile';
  return {
    status: 'ADVISORY',
    from: from.symbol,
    to: to.symbol,
    fromAmount: fromAmount.toString(),
    toAmount: toAmount.toString(),
    priceSource: 'caller_supplied',
    priceVerified: false,
    floored,
    applied: false,
    note:
      'ADVISORY: arithmetic is exact, but the PRICE is the caller\'s assertion, not a measured rate.' +
      (crossVolatility ? ' Crosses a volatile token — the real rate can move before settlement.' : ''),
  };
}

export interface CommonTokenResult {
  /** Tokens BOTH parties accept AND that are transfer-ready (VERIFIED address). */
  common: string[];
  /** Of those, the ones that are fiat-stable — the safest to settle in. */
  stableCommon: string[];
  /** True when the parties share no transfer-ready token at all. */
  none: boolean;
  note: string;
}

/**
 * Pure set logic: which tokens do BOTH parties accept? No price needed, so this is
 * a verifiable fact rather than a quote — the safest option an agent can offer.
 * Only transfer-ready (VERIFIED) tokens count; a NOT_CHECKED token is never offered
 * as common ground. Stable commons are surfaced first because settling in a
 * fiat-pegged token sidesteps the volatility an unverified rate would otherwise risk.
 */
export function commonSettlementTokens(
  partyAAccepts: readonly string[],
  partyBAccepts: readonly string[],
): CommonTokenResult {
  const normalize = (list: readonly string[]) =>
    new Set(
      list
        .map((s) => getToken(s))
        .filter((t): t is BaseSepoliaToken => isTransferReady(t))
        .map((t) => t.symbol),
    );
  const a = normalize(partyAAccepts);
  const b = normalize(partyBAccepts);
  const common = [...a].filter((s) => b.has(s));
  const stableCommon = common.filter((s) => getToken(s)?.volatility === 'stable');
  return {
    common,
    stableCommon,
    none: common.length === 0,
    note:
      common.length === 0
        ? 'no transfer-ready token accepted by both parties; a conversion (with its unverified-price caveat) would be required'
        : 'these are accepted by both parties and transfer-ready; stableCommon avoids exchange-rate risk',
  };
}

export interface TransferCostEstimate {
  symbol: string;
  /** Typical gas UNITS for a plain transfer. A static heuristic, not a live quote. */
  gasUnits: number;
  kind: 'native' | 'erc20';
}

export interface TransferCostRanking {
  ranked: TransferCostEstimate[];
  cheapest: string | null;
  estimateBasis: 'heuristic_gas_units';
  /** Gas PRICE is not read here, so absolute cost is unknown. */
  absoluteCostVerified: false;
  note: string;
}

// Plain-transfer gas, by kind. Native sends are ~21k; a first-touch ERC-20 transfer
// is materially more (storage write). These are textbook ballparks, not measurements,
// and the ranking says so.
const NATIVE_TRANSFER_GAS = 21_000;
const ERC20_TRANSFER_GAS = 55_000;

/**
 * Rank transfer-ready tokens by TYPICAL transfer gas, cheapest first. This answers
 * "which is cheapest to move" only in RELATIVE, heuristic terms: gas price is not
 * read, so the absolute cost is NOT known here (absoluteCostVerified: false). Native
 * ETH is cheapest to move; ERC-20s cost more and are treated as equal to each other
 * at this resolution, because distinguishing them needs a live gas reading we do not take.
 */
export function rankByTransferCost(symbols: readonly string[]): TransferCostRanking {
  const estimates: TransferCostEstimate[] = symbols
    .map((s) => getToken(s))
    .filter((t): t is BaseSepoliaToken => isTransferReady(t))
    .map((t) => ({
      symbol: t.symbol,
      kind: t.address === null ? ('native' as const) : ('erc20' as const),
      gasUnits: t.address === null ? NATIVE_TRANSFER_GAS : ERC20_TRANSFER_GAS,
    }));
  // Stable sort by gasUnits; symbol as tiebreak so the result is deterministic.
  const ranked = [...estimates].sort(
    (x, y) => x.gasUnits - y.gasUnits || x.symbol.localeCompare(y.symbol),
  );
  return {
    ranked,
    cheapest: ranked.length > 0 ? (ranked[0] as TransferCostEstimate).symbol : null,
    estimateBasis: 'heuristic_gas_units',
    absoluteCostVerified: false,
    note: 'RELATIVE heuristic only: native < ERC-20 by gas units. Gas price is not read, so absolute cost is NOT_CHECKED.',
  };
}
