//
// mint-price.mjs — which price the daily living-proof exchange pays, and where it came from.
//
// Pure and separate for the same reason as rate-deliverable.mjs: mint-attestation.mjs self-executes
// on import, so nothing inside it can be tested without moving real testnet USDC.
//
// MINT_PRICE_USDC_RAW is an optional override, default-inert:
//   unset  -> the provider's listed agent_services.base_price_usdc_raw (unchanged behaviour)
//   set    -> a positive integer of raw USDC units (1000000 = 1 USDC), at most MAX_MINT_PRICE_USDC_RAW.
// Anything else REFUSES with a named error, before any key is minted or any money moves. A typo must
// not silently fall back to the listed price, nor pay more than the cap.

/** 5 USDC. The ceiling an env typo can spend in one run. */
export const MAX_MINT_PRICE_USDC_RAW = 5_000_000;

export function resolveMintPrice(envValue, listedRaw) {
  if (envValue === undefined) {
    return { raw: Number(listedRaw), source: 'agent_services.base_price_usdc_raw' };
  }
  const s = String(envValue).trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(
      `MINT_PRICE_INVALID: MINT_PRICE_USDC_RAW must be a positive integer of raw USDC units ` +
      `(1000000 = 1 USDC); got ${JSON.stringify(envValue)}. Unset it to use the listed price.`,
    );
  }
  const raw = Number(s);
  if (raw > MAX_MINT_PRICE_USDC_RAW) {
    throw new Error(
      `MINT_PRICE_TOO_HIGH: MINT_PRICE_USDC_RAW=${s} exceeds the cap of ${MAX_MINT_PRICE_USDC_RAW} (5 USDC).`,
    );
  }
  return { raw, source: 'env MINT_PRICE_USDC_RAW' };
}
