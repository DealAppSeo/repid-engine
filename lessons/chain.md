<!-- triggers: wallet signer faucet testnet sepolia usdc escrow onchain on-chain basescan erc8004 erc-8004 givefeedback x402 -->
# Wallet, signing and on-chain lessons

## Choose the signer from what the owner can sign with
2026-11-16: three E2E owner wallets were picked from chain facts (funded, unused, no SBT). The
owner held none of their keys. **Apply:** first ask which keys the owner can sign with. Then
check role (a wallet in `human_sbt_registry` binds as `human_sbt`, which has no owner budget),
other signers on that key (crons), and funds. Keys go in at a hidden prompt, never in chat.

## Attribute on-chain activity from the transaction
2026-07-08 writes were rightly ruled out as faucet clicks by their selector: `giveFeedback` to the
Reputation Registry, where a faucet claim is `claim()` to the faucet. They were then also ruled out
by an invented timing reason. They came from an unlogged E2E test run. **Apply:** decode from, to
and selector; read the record behind it; say what you cannot attribute; log every chain run in
`E:\dev\ops\loop\chain-activity.jsonl`.
