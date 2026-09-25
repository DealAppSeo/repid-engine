# Testnet walkthrough

Base Sepolia only. Chain id **84532**. The engine does not send ETH. `GET /api/v1/faucet/info` returns `dispenses: false`.

Use a public faucet yourself:

1. https://www.coinbase.com/faucets/base-sepolia
2. https://sepolia.base.org/faucet
3. https://www.alchemy.com/faucets/base-sepolia

## Six steps

1. **Sign up.** The account path is the email code. This page does not call token signup.
2. **Connect a wallet.** Sign the sentence the API shows. An empty connect, with no signature, is 401 and inserts no account.
3. **Get testnet tokens.** Stay on chain 84532. The engine faucet dispenses nothing. The three links above do.
4. **Stake.** The after-create card says `can_stake: false`. An empty stake body is rejected before any credit. The real-staking gate is not flipped here.
5. **Bind an agent.** Bound means a signature that names your wallet and that agent. Linked is not bound. The bind door is open only when its flag is the exact string true.
6. **Blast-radius cap.** `GET /api/v1/human/path` records the walk. Every step is `applied: false`. Your cap can only shrink the agent's cap, and the live payment decision does not use it yet.

`GET /api/v1/after-create` reports `can_verify: true` and `can_stake: false`.

## Still unwired

| Piece | State |
|---|---|
| Owner-ceiling enforce | Off. The observer records a comparison. The payment decision ignores it. |
| Stake-authority enforce | Off. The live gate still reads the prediction-market stake table. |
| Real staking | Not flipped. `can_stake` stays false. |
| Honesty A | `GET /api/v1/hal/honesty-a` is a count only when quorum vote rows are readable. The vote writer is default off. A failed read is `NOT_CHECKED` with no rows. It is not a latency reading, and it carries no claim text and no user id. |
| Mainnet | Not this walk. No ETH is moved by this document. |
