/**
 * Base Sepolia token registry (chain 84532 ONLY). A read-only catalogue of the
 * tokens an agent may be asked to price, hold, or settle in. It builds no
 * transaction, reads no chain, and moves no funds — it answers "what is this
 * token, and do we actually KNOW its address" and nothing else.
 *
 * THREE OUTCOMES ON THE ADDRESS ITSELF, never two. Each entry carries a
 * `confidence`:
 *   • VERIFIED    — the address is corroborated against an authoritative source
 *                   (already in src/config.ts, a canonical chain predeploy, or
 *                   the issuer's own docs). Safe to rely on for a real transfer.
 *   • NOT_CHECKED — we have a candidate address but NO authoritative confirmation.
 *                   `isTransferReady` returns false for it, so a NOT_CHECKED token
 *                   can never be the leg of a real send. It is listed, honestly,
 *                   as unconfirmed — not silently dropped and not silently trusted.
 *
 * A NOT_CHECKED address is NOT a FAILED one: the token may well exist at that
 * address. We simply have not proven it here, and an unproven address must never
 * read as a proven one. Fabricating an address would be the worst failure of all,
 * so an address we could not confirm is labelled, not invented.
 *
 * `source` records WHERE each VERIFIED address was confirmed, so the claim is
 * auditable and a future reader can re-check it rather than trust this file.
 */

export const TOKEN_REGISTRY_CHAIN_ID = 84532; // Base Sepolia. Mirrors BASE_SEPOLIA_CHAIN_ID.

export type TokenConfidence = 'VERIFIED' | 'NOT_CHECKED';

/** 'stable' = fiat-pegged; 'volatile' = free-floating. Advisory metadata only. */
export type TokenVolatility = 'stable' | 'volatile';

export interface BaseSepoliaToken {
  symbol: string;
  name: string;
  /** ERC-20 contract address, or null for the native coin (ETH has no contract). */
  address: string | null;
  decimals: number;
  confidence: TokenConfidence;
  volatility: TokenVolatility;
  /** Where a VERIFIED address was confirmed, or why an address is NOT_CHECKED. */
  source: string;
}

/**
 * The catalogue. Addresses that are VERIFIED are corroborated; the one that is
 * NOT_CHECKED says so out loud. Do NOT promote an entry to VERIFIED without
 * recording the authoritative source you checked it against in `source`.
 */
export const BASE_SEPOLIA_TOKENS: Readonly<Record<string, BaseSepoliaToken>> = {
  ETH: {
    symbol: 'ETH',
    name: 'Ether (native, Base Sepolia gas coin)',
    address: null, // native — there is no contract to verify.
    decimals: 18,
    confidence: 'VERIFIED',
    volatility: 'volatile',
    source: 'native coin; no ERC-20 contract. Gas is paid in ETH.',
  },
  WETH: {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    confidence: 'VERIFIED',
    volatility: 'volatile',
    source: 'canonical OP-Stack / Base predeploy (0x42..0006), identical on every Base chain',
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin (Circle)',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    confidence: 'VERIFIED',
    volatility: 'stable',
    source: 'already in src/config.ts usdcTokenAddress; Circle Base Sepolia docs',
  },
  EURC: {
    symbol: 'EURC',
    name: 'Euro Coin (Circle)',
    address: '0x808456652fdb597867f38412077A9182bf77359F',
    decimals: 6,
    confidence: 'VERIFIED',
    volatility: 'stable',
    source: "Circle official docs (developers.circle.com EURC contract addresses, Base Sepolia row)",
  },
  cbBTC: {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    // Strong-but-incomplete provenance, so NOT_CHECKED by design. Basescan shows a
    // source-verified FiatTokenProxy labelled "Coinbase Wrapped BTC (cbBTC)", 8
    // decimals, ~2,143 holders at this address on Base Sepolia, and the Coinbase
    // Developer Platform faucet dispenses cbBTC on Base Sepolia. What is MISSING:
    // Coinbase has published no docs-table naming the testnet contract, so the
    // issuer-canonical claim rests on the explorer label, not the issuer. Two
    // hazards keep this fail-closed: (1) the Base MAINNET cbBTC is a DIFFERENT
    // address (0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf) — never interchange
    // them; (2) a money leg must not ride an unconfirmed contract. To promote to
    // VERIFIED: confirm a Coinbase-published source AND call decimals()/symbol()
    // on-chain once. isTransferReady refuses it until then.
    address: '0xcbB7C0006F23900c38EB856149F799620fcb8A4a',
    decimals: 8,
    confidence: 'NOT_CHECKED',
    volatility: 'volatile',
    source: 'basescan source-verified FiatTokenProxy "Coinbase Wrapped BTC (cbBTC)", 8dp, ~2143 holders + CDP faucet; NO Coinbase docs-table provenance — verify on-chain before promoting',
  },
};

/** All catalogued tokens, newest-safe order not implied. */
export function listTokens(): BaseSepoliaToken[] {
  return Object.values(BASE_SEPOLIA_TOKENS);
}

/** Case-insensitive symbol lookup. Returns null for an unknown symbol — an
 *  unknown token is never silently coerced into a known one. */
export function getToken(symbol: unknown): BaseSepoliaToken | null {
  if (typeof symbol !== 'string') return null;
  const key = Object.keys(BASE_SEPOLIA_TOKENS).find(
    (k) => k.toLowerCase() === symbol.trim().toLowerCase(),
  );
  return key ? (BASE_SEPOLIA_TOKENS[key] as BaseSepoliaToken) : null;
}

/**
 * The gate between the catalogue and a real transfer. A token is transfer-ready
 * ONLY when its address is VERIFIED (or it is the native coin). A NOT_CHECKED
 * token — however plausible its address — returns false here, so an unconfirmed
 * address can never become the leg of a real send. This is the fail-closed edge:
 * not proven is not the same as proven.
 */
export function isTransferReady(token: BaseSepoliaToken | null): boolean {
  if (!token) return false;
  if (token.confidence !== 'VERIFIED') return false;
  if (token.address === null) return true; // native coin, no contract to confirm
  return /^0x[0-9a-fA-F]{40}$/.test(token.address);
}

/** The symbols an agent may safely settle in today: VERIFIED addresses only. */
export function transferReadySymbols(): string[] {
  return listTokens()
    .filter(isTransferReady)
    .map((t) => t.symbol);
}
