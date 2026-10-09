# Multi-token advisory slice (Base Sepolia)

**Status:** advisory + read-only. Shipped 2026-10-08. Nothing in this slice builds a
transaction, reads a chain, holds funds, or signs anything. It is the honest
scaffolding under "let agents experiment with settling in different tokens", built so
that when real value ever rides on it, the safety edges are already in place and nothing
major has to change.

## Why this exists

The engine settles in a single token (USDC) today. The ask was to let agents, when two
parties want different tokens, **(1)** do the conversion math to find the equivalent,
**(2)** find a common token both already accept, and **(3)** find the cheapest token to
move — while the **human** decides which tokens their agents may accept at all. On
testnet this is experimentation. On mainnet, with volatile tokens, a sloppy version of
this is exactly what an adversary would try to game. So the slice is built honesty-first.

## The three modules

| Module | What it does | Reads a chain? | Moves funds? |
|---|---|---|---|
| `src/services/token-registry.ts` | Catalogue of Base Sepolia tokens, each with a **confidence** on its address | no | no |
| `src/services/token-equivalence.ts` | Advisory conversion math, common-token discovery, transfer-cost ranking | no | no |
| `src/services/accepted-tokens-policy.ts` | The human's allow-list gate; fail-closed | no | no |

## The honesty rules (the whole point)

1. **An address we did not confirm is `NOT_CHECKED`, never fabricated.** The registry
   carries a per-token confidence (`VERIFIED` / `NOT_CHECKED`). A `NOT_CHECKED` token is
   *listed* honestly (not silently dropped, not silently trusted) and `isTransferReady`
   refuses it, so it can never become the leg of a real send.
2. **A price we did not measure is `NOT_CHECKED`, never a firm number and never 1:1.**
   There is no verified price oracle wired. So `convertAmount` with no price returns
   `NOT_CHECKED` (which is *not* "the tokens are equal"); with a **caller-supplied**
   price it returns `ADVISORY`, stamped `priceSource: 'caller_supplied'`,
   `priceVerified: false`. The arithmetic is ours and exact; the rate is the caller's
   assertion, and the result always says so. This is the anti-exploit edge: an unverified
   exchange rate can never masquerade as a quote.
3. **The cheapest-to-move answer is a labeled heuristic, not a live quote.**
   `rankByTransferCost` ranks by *typical gas units* (native < ERC-20) and reports
   `absoluteCostVerified: false` — gas price is not read, so absolute cost is NOT_CHECKED.
4. **Common-token discovery is pure and needs no price** — "we both already accept USDC"
   is a verifiable fact, so it is the safest option an agent can propose.
5. **The human is the gate, fail-closed.** `accepted-tokens-policy` accepts only what the
   human listed. No policy set → **USDC only** (today's behaviour, unchanged). Unknown
   token → refused. A `NOT_CHECKED` token → refused even if the human listed it. Empty
   list → accept nothing. The agent proposes within the mandate; it never widens it.

## Verified Base Sepolia addresses (chain 84532)

Corroborated 2026-10-08 against Circle docs / basescan / the canonical predeploy.

| Token | Address | Dp | Confidence | Source |
|---|---|---|---|---|
| ETH (native) | — (gas coin, no contract) | 18 | VERIFIED | native |
| WETH | `0x4200…0006` | 18 | VERIFIED | OP-Stack/Base predeploy, basescan source-verified |
| USDC | `0x036C…cF7e` | 6 | VERIFIED | Circle docs; already in `config.ts` |
| EURC | `0x8084…359F` | 6 | VERIFIED | Circle docs; basescan name/symbol/6dp |
| cbBTC | `0xcbB7…A4a` | 8 | **VERIFIED** | Promoted 2026-10-08 by a DIRECT on-chain read (`eth_call` via `pg_net`): `symbol()`=="cbBTC", `decimals()`==8, `eth_chainId`==0x14a34 (84532); + basescan source-verified FiatTokenProxy (~2,143 holders) + CDP faucet. Note: **Base MAINNET cbBTC is a DIFFERENT address** (`0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`) — never interchange. |

Faucets: ETH via the Coinbase Developer Platform faucet; USDC + EURC via `faucet.circle.com`
(no account, ~10/req, 1/24h). cbBTC via the CDP faucet (Circle's faucet dispenses *cirBTC*,
not Coinbase's cbBTC — different token).

## What this slice deliberately does NOT do

- No swap, no DEX, no bridge, no on-chain transfer. "Equivalence" here is arithmetic and
  set logic, not a trade.
- No price oracle. Wiring a verified price source is the next decision, and until then
  every real cross-token quote is honestly `NOT_CHECKED`.
- No change to how escrow is custodied. The escrow is still an EOA (see the custody note);
  moving off it is a separate, human-gated decision.
