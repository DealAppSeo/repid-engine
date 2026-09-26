# Human testnet onboard

For a person, not a developer. Testnet only. This engine does not send ETH, and it does not move a token when you follow this page.

Chain: **Base Sepolia, chain id 84532.** If your wallet shows a different chain id, stop. Mainnet is not this path.

The engine does not dispense. `GET /api/v1/faucet/info` returns `dispenses: false`. You get test ETH from one of these public faucets, yourself:

1. https://www.coinbase.com/faucets/base-sepolia — test ETH and test USDC. A Coinbase account is recommended.
2. https://sepolia.base.org/faucet — test ETH, run by Base.
3. https://www.alchemy.com/faucets/base-sepolia — test ETH. A free Alchemy account is required.

## Click by click

1. Install a browser wallet that can add a network. Add Base Sepolia if it is not already listed. The chain id must read **84532**. Do not type a private key into a chat, a form on this engine, or a document.

2. Copy your wallet address. Open one of the three faucet links above. Request test ETH to that address. Wait until the wallet shows a test balance on chain 84532. The engine did not send it.

3. Optional check, still no payment: open
   `https://repid-engine-production.up.railway.app/api/v1/faucet/balance?address=YOUR_ADDRESS`
   and read the balance. That call only reads.

4. Create the account with the email code, not with token signup. Token signup (`POST /api/v1/builder/token-signup`) inserts a builder row. In this branch it answers **410** and writes nothing unless an operator set the flag to the exact string `true`. Email OTP is the account path. Production was not called for token signup, so that door is **NOT_CHECKED** there. Email OTP was open on the deployed process (commit `a7c6ad0`, measured 2026-09-25).

5. Connect the wallet by signing the sentence the site shows you. Signing is not a payment. An empty connect, with no signature, is rejected: **401** `signature_required`, and no account row is inserted. Measured on production 2026-09-24: that door is open, and the empty call returned that 401.

6. Stake is a later, separate signature, and this page does not do it. An empty stake call is rejected: **400**, missing `builder_address` and `amount`, before any credit. Whether production treats a chain transfer as real (`REAL_STAKING_ENABLED`) was **not checked**.

7. Bind an agent only if you mean to own it. **Bound** means a signature that names your wallet and that agent. The engine recovers the signer. A database column that merely stores your account id next to the agent is **linked**, and linked is not bound. An unbound agent cannot spend under the shadow rule below.

8. The blast-radius cap is recorded and not enforced. Your cap can only shrink the agent's cap. Over that number, the shadow says deny. The live payment decision does not read it yet.

## What the published TrustShell rows already say

These are the README rows, not a new production measurement, and this change does not edit that README:

- x402 pay is paused for a person without a key. It needs an API key and a funded Base Sepolia wallet. It is not mainnet.
- `register()` is keyless. It creates an agent and a RepID. It does not mint an ERC-8004 identity.
- The ERC-8004 mint is a separate, keyed call. A keyless register leaves the agent `NOT_MINTED`.

## Flow — human cap, then agent cap, then deny

```
human cap (what you allow, USDC per transaction)
        |
        v
agent cap (what that agent's tier allows)
        |
        v
effective cap = the smaller of the two
        |
        +-- unbound agent --------------------------> DENY  (linked is not bound)
        +-- stake not checked, or no stake ---------> DENY
        +-- amount over the effective cap ----------> DENY  (fail closed)
        +-- amount under the cap -------------------> record "would allow"
                                                       applied: false
                                                       the live gate is not asked
```

Nothing in that picture moves a token. `enforced` stays false.

## Checklist

| Situation | Shadow result |
|-----------|----------------|
| No stake | No spend |
| Stake present, and both caps were looked up | The effective cap is a number you can read |
| Agent is not bound | No spend, even if a stake exists |
| Amount over the smaller cap | Deny |
| Amount under the smaller cap | Would allow, and still not applied |

## Route table

Measured keyless against production commit `a7c6ad0` at 2026-09-25 04:00Z. This branch is that commit plus this table. Token signup and `POST /agents/human` were not called. No token was moved.

| route | this branch | production | NOT_CHECKED |
|---|---|---|---|
| `GET /api/v1/human/path` | 200, `applied: false` on every step | 200, `applied: false` on every step | |
| `GET /api/v1/faucet/info` | `dispenses: false` | `dispenses: false`, chain id 84532 | |
| `GET /api/v1/faucet/balance` with no address | 400, missing address | 400, missing address | |
| `POST /api/v1/account/connect` with `{}` | 401 `signature_required` when the door is open; no insert | 401 `signature_required` | |
| `POST /api/v1/stake/deposit` with `{}` | 400, missing `builder_address` and `amount`; no credit | 400, same missing fields | |
| `POST /api/v1/human/bind` with `{}` | 401 `signature_required` before any binding write | 401 `signature_required` | |
| `POST /api/v1/builder/token-signup` | 410 unless the flag is the exact string `true`; no insert | not called | NOT_CHECKED |
| `POST /agents/human` | writes the returned private id into `constitution` | not called | NOT_CHECKED |
| `REAL_STAKING_ENABLED` | gate unchanged; not on `GET /readiness` | absent from `GET /readiness` | NOT_CHECKED |
| `OWNER_CEILING_SHADOW_ENABLED` | observer only; not a payment decision | absent from `GET /readiness` | NOT_CHECKED |
| `STAKE_AUTHORITY_SHADOW_ENABLED` | observer only; not a payment decision | absent from `GET /readiness` | NOT_CHECKED |

`GET /readiness` on that deploy reported `SELF_SERVE_ACCOUNTS_ENABLED` on and `HUMAN_AGENT_BIND_ENABLED` on.

## Still unwired

- Owner-ceiling enforce. `observeOwnerCeiling` records a comparison. `checkTransactionAuthority` ignores it.
- Stake-authority enforce. The live gate still sums `agent_stakes` (a prediction market). Posted collateral is `stake_deposits`. `repid_agents` has no `stake_amount` column. This work does not add one.
- `REAL_STAKING_ENABLED`, `OWNER_CEILING_SHADOW_ENABLED`, and `STAKE_AUTHORITY_SHADOW_ENABLED` are not on the public readiness list. Production values are **not checked**.
- `GET /api/v1/human/path` is on the deployed commit `a7c6ad0` and answered 200 with `applied: false` on every step (measured 2026-09-25).
- Token signup is closed in this branch (410, no insert) unless the flag is exactly `true`. Production was not called. No rows were deleted.
- No mainnet. No testnet token was moved.
